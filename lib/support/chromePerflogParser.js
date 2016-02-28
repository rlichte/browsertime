'use strict';

let log = require('intel'),
  Cookie = require('tough-cookie').Cookie,
  urlParser = require('url'),
  util = require('util'),
  moment = require('moment');

module.exports = {
  eventFromLogEntry: function(logEntry) {
    const logContent = JSON.parse(logEntry.message);

    return {
      timestamp: logEntry.timestamp,
      method: logContent.message.method,
      data: logContent.message.params,
      webview: logContent.webview
    }
  },
  harFromEvents: function(events) {
    function populateEntryFromResponse(entry, response, timestamp) {
      entry.response = {
        httpVersion: response.protocol,
        redirectURL: '',
        status: response.status,
        statusText: response.statusText,
        content: {
          mimeType: response.mimeType,
          size: 0
        },
        headersSize: -1,
        bodySize: -1,
        cookies: [],
        headers: parseHeaders(response.headers)
      };

      let locationHeaderValue = getHeaderValue(response.headers, 'Location');
      if (locationHeaderValue) {
        entry.response.redirectURL = locationHeaderValue;
      }

      entry.request.httpVersion = response.protocol;

      if (response.fromDiskCache === true && isHttp1x(response.protocol)) {
        entry.response.headersSize = calculateResponseHeaderSize(response);
      } else {
        if (response.requestHeaders) {
          entry.request.headers = parseHeaders(response.requestHeaders);

          const cookieHeader = getHeaderValue(response.requestHeaders, 'Cookie');
          entry.request.cookies = parseCookies(cookieHeader.split(';'));
        }

        if (isHttp1x(response.protocol)) {
          if (response.headersText) {
            entry.response.headersSize = response.headersText.length;
          } else {
            entry.response.headersSize = calculateResponseHeaderSize(response);
          }

          if (response.requestHeadersText) {
            entry.request.headersSize = response.requestHeadersText.length;
          } else {
            // Since entry.request.httpVersion is now set, we can calculate header size.
            entry.request.headersSize = calculateRequestHeaderSize(entry.request);
          }
        }
      }

      entry.connection = response.connectionId.toString();
      entry._connectionReused = response.connectionReused;

      let timing = response.timing;
      if (timing) {
        let blocked = firstNonNegative([timing["dnsStart"], timing["connectStart"], timing["sendStart"]]);

        let dns = -1;
        if (timing["dnsStart"] >= 0) {
          dns = firstNonNegative([timing["connectStart"], timing["sendStart"]]) - timing["dnsStart"];
        }
        let connect = -1;
        if (timing["connectStart"] >= 0) {
          connect = timing["sendStart"] - timing["connectStart"];
        }
        let send = timing["sendEnd"] - timing["sendStart"];
        let wait = timing["receiveHeadersEnd"] - timing["sendEnd"];
        let receive = timestamp - timing["requestTime"];

        let ssl = -1;
        if (timing["sslStart"] >= 0 && timing["sslEnd"] >= 0) {
          ssl = timing["sslEnd"] - timing["sslStart"];
        }

        entry.timings = {
          blocked,
          dns,
          connect,
          send,
          wait,
          receive,
          ssl
        };

        entry._requestSentTime = timing["requestTime"];

        const max = Math.max;
        entry.time = max(0, blocked) + max(0, dns) + max(0, connect) + send + wait + receive;

        //TODO: figure out how to correctly calculate startedDateTime for connections reused
        
        entry.time += entry.timings.blocked;

      } else {
        entry.timings = {
          blocked: -1,
          dns: -1,
          connect: -1,
          send: 0,
          wait: 0,
          receive: 0,
          ssl: -1,
          comment: 'No timings available from Chrome'
        };
        entry.time = 0;
      }
    }

    let pages = [],
      entries = [],
      currentPageId,
      ongoingDataRequests = new Set(),
      rootFrameMappings = new Map();

    for (let event of events) {
      const data = event.data;
      switch (event.method) {
        case 'Page.frameStartedLoading':
        {
          const frameId = data.frameId;

          if (rootFrameMappings.has(frameId)) {
            // This is a sub frame, there's already a page for the root frame
            continue;
          }

          currentPageId = 'page_' + (pages.length + 1);
          let page = {
            id: currentPageId,
            startedDateTime: moment(event.timestamp).toISOString(),
            title: '',
            pageTimings: {},
            _frameId: data.frameId
          };
          pages.push(page);
        }
          break;

        case 'Network.requestWillBeSent':
        {
          if (pages.length < 1) {
            //we havent loaded any pages yet.
            continue
          }
          const request = data.request;
          if (request.url.startsWith('data:')) {
            ongoingDataRequests.add(data.requestId);
            continue;
          }
          let frameId = rootFrameMappings.get(data.frameId) || data.frameId;
          let page = pages.find((page) => page._frameId === frameId);
          if (!page) {
            log.warn('Request will be sent with requestId ' + data.requestId + ' that can\'t be mapped to any page.');
            continue;
          }

          const cookieHeader = getHeaderValue(request.headers, 'Cookie');
          const cookies = parseCookies(cookieHeader.split(';'));

          let req = {
            method: request.method,
            url: request.url,
            _timestamp: data.timestamp,
            queryString: parsePostParams(request.url),
            headersSize: -1,
            bodySize: -1,
            _initialPriority: request.initialPriority,
            cookies: cookies,
            headers: parseHeaders(request.headers)
          };

          let entry = {
            cache: {},
            startedDateTime: moment.unix(data.wallTime).toISOString(), //epoch float64, eg 1440589909.59248
            _requestWillBeSentTime: data.timestamp,
            _wallTime: data.wallTime,
            _requestId: data.requestId,
            _frameId: data.frameId,
            pageref: currentPageId,
            request: req,
            time: 0
          };

          if (data.redirectResponse) {
            let previousEntry = entries.find((entry) => entry._requestId === data.requestId);
            previousEntry._requestId += 'r';
            populateEntryFromResponse(previousEntry, data.redirectResponse, data.timestamp);
          }

          entries.push(entry);

          // this is the first request for this page, so set timestamp of page.
          if (!page._timestamp) {
            page._wallTime = data.wallTime;
            page._timestamp = data.timestamp;
            page.startedDateTime = entry.startedDateTime;
            // URL is better than blank, and it's what devtools uses.
            page.title = request.url;
          }
        }
          break;

        case 'Network.responseReceived':
        {
          if (pages.length < 1) {
            //we havent loaded any pages yet.
            continue
          }
          if (data.response.url.startsWith('data:')) {
            continue;
          }

          let entry = entries.find((entry) => entry._requestId === data.requestId);
          if (!entry) {
            log.warn('Recieved network response for requestId ' + data.requestId + ' with no matching request.');
            continue;
          }
          entry._responseReceivedTime = data.timestamp;
          entry._totalRequestTime = (data.timestamp - entry._requestWillBeSentTime) * 1000;

          try {
            populateEntryFromResponse(entry, data.response, data.timestamp);
          } catch (e) {
            log.error('Error parsing response: ' + JSON.stringify(data, null, 2));
            throw e;
          }
        }
          break;

        case 'Network.dataReceived':
        {
          if (pages.length < 1) {
            //we havent loaded any pages yet.
            continue
          }
          if (ongoingDataRequests.has(data.requestId)) {
            continue;
          }

          let entry = entries.find((entry) => entry._requestId === data.requestId);
          if (!entry) {
            log.warn('Recieved network data for requestId ' + data.requestId + ' with no matching request.');
            continue;
          }

          entry._dataReceivedTime = entry._responseReceivedTime;
          entry.response.content.size += data.dataLength;
        }
          break;

        case 'Network.loadingFinished':
        {
          if (pages.length < 1) {
            //we havent loaded any pages yet.
            continue
          }
          if (ongoingDataRequests.has(data.requestId)) {
            ongoingDataRequests.delete(data.requestId);
            continue;
          }

          let entry = entries.find((entry) => entry._requestId === data.requestId);
          if (!entry) {
            log.warn('Network loading finished for requestId ' + data.requestId + ' with no matching request.');
            continue;
          }

          entry._loadingFinishedTime = data.timestamp;
          entry.response.bodySize = entry.response.content.size;
          //if (entry.response.headersSize > -1) {
          //  entry.response.bodySize -= entry.response.headersSize;
          //}

          // encodedDataLength will be -1 sometimes
          if (data.encodedDataLength > 0) {
            // encodedDataLength seems to be larger than body size sometimes. Perhaps it's because full packets are
            // listed even though the actual data might be very small.
            // I've seen dataLength: 416, encodedDataLength: 1016,

            const compression = Math.max(0, entry.response.bodySize - data.encodedDataLength);
            if (compression > 0) {
              entry.response.content.compression = compression;
            }
          }
        }
          break;

        case 'Page.loadEventFired':
        {
          if (pages.length < 1) {
            //we havent loaded any pages yet.
            continue;
          }

          let page = pages[pages.length - 1];

          if (data.timestamp && page._timestamp) {
            page.pageTimings.onLoad = Number((data.timestamp - page._timestamp) * 1000)
          }
        }
          break;

        case 'Page.domContentEventFired':
        {
          if (pages.length < 1) {
            //we havent loaded any pages yet.
            continue;
          }

          let page = pages[pages.length - 1];

          if (data.timestamp && page._timestamp) {
            page.pageTimings.onContentLoad = Number((data.timestamp - page._timestamp) * 1000)
          }
        }
          break;

        case 'Page.frameAttached':
        {
          let parentId = data.parentFrameId;

          rootFrameMappings.set(data.frameId, parentId);

          let grandParentId = rootFrameMappings.get(parentId);
          while (grandParentId) {
            rootFrameMappings.set(data.frameId, grandParentId);
            grandParentId = rootFrameMappings.get(grandParentId);
          }
        }
          break;

        case 'Page.frameScheduledNavigation':
        case 'Page.frameNavigated':
        case 'Page.frameStoppedLoading':
        case 'Page.frameClearedScheduledNavigation':
        case 'Page.frameDetached':
        case 'Page.frameResized':
          // ignore
          break;

        case 'Page.javascriptDialogOpening':
        case 'Page.javascriptDialogClosed':
        case 'Page.screencastFrame':
        case 'Page.screencastVisibilityChanged':
        case 'Page.colorPicked':
        case 'Page.interstitialShown':
        case 'Page.interstitialHidden':
          // ignore
          break;

        case 'Network.requestServedFromCache':
        case 'Network.loadingFailed':
          // FIXME, should not ignore these
          break;

        case 'Network.webSocketCreated':
        case 'Network.webSocketFrameSent':
        case 'Network.webSocketFrameError':
        case 'Network.webSocketFrameReceived':
        case 'Network.webSocketClosed':
        case 'Network.webSocketHandshakeResponseReceived':
        case 'Network.webSocketWillSendHandshakeRequest':
          // ignore, sadly HAR file format doesn't include web sockets
          break;

        case 'Network.eventSourceMessageReceived':
          // ignore
          break;

        default:
          log.warn('Unhandled event: ' + event.method);
          break;
      }
    }

    entries = entries.filter((entry) => {
      // Page doesn't wait for favicon to load, and that's ok (for now).
      if (!entry.response && !entry.request.url.endsWith('.ico')) {
        log.warn('Entry without response!: ' + JSON.stringify(entry));
      }
      return entry.response;
    });

    return {
      log: {
        version: "1.2",
        creator: {"name": "Browsertime", "version": "1.0"},
        pages,
        entries
      }
    }
  }
};

function calculateRequestHeaderSize(harRequest) {
  let buffer = '';
  buffer = buffer.concat(util.format('%s %s %s\r\n', harRequest.method, harRequest.url, harRequest.httpVersion));

  const headerLines = harRequest.headers.map((header) => util.format('%s: %s\r\n', header.name, header.value));
  buffer = buffer.concat(headerLines.join(''));
  buffer = buffer.concat('\r\n');

  return buffer.length;
}

function calculateResponseHeaderSize(perflogResponse) {
  let buffer = '';
  buffer = buffer.concat(util.format('%s %d %s\r\n', perflogResponse.protocol, perflogResponse.status, perflogResponse.statusText));
  Object.keys(perflogResponse.headers).forEach((key) => {
    buffer = buffer.concat(util.format('%s: %s\r\n', key, perflogResponse.headers[key]));
  });
  buffer = buffer.concat('\r\n');

  return buffer.length;
}

function parseCookies(cookieStrings) {
  return cookieStrings.filter(Boolean).map((cookieString) => {
    let cookie = Cookie.parse(cookieString);
    if (!cookie) {
      log.warn("Invalid cookie - failed to parse value: " + cookieString);

      return null;
    }

    return {
      'name': cookie.key,
      'value': cookie.value,
      'path': cookie.path || undefined, // must be undefined, not null, to exclude empty path
      'domain': cookie.domain || undefined,  // must be undefined, not null, to exclude empty domain
      'expires': cookie.expires === 'Infinity' ? undefined : moment(cookie.expires).toISOString(),
      'httpOnly': cookie.httpOnly,
      'secure': cookie.secure
    };
  });
}

function parseHeaders(headers) {
  if (!headers) {
    return [];
  }
  return Object.keys(headers).map((key) => {
    return {
      name: key,
      value: headers[key]
    }
  });
}

function getHeaderValue(headers, header) {
  if (!headers) {
    return '';
  }
  // http header names are case insensitive
  const lowerCaseHeader = header.toLowerCase();
  const headerNames = Object.keys(headers);
  return headerNames.filter((key) => key.toLowerCase() === lowerCaseHeader)
      .map((key) => headers[key]).shift() || '';
}


function parsePostParams(text) {
  var paramList = [];
  var queryString = urlParser.parse(text, true).query;
  Object.keys(queryString).forEach(function(name) {
    var value = queryString[name];
    if (!Array.isArray(value))
      value = [value];
    value.forEach(function(v) {
      paramList.push(
        {
          "name": name,
          "value": v
          //                    "fileName": "example.pdf",
          //                    "contentType": "application/pdf",
        });
    });
  });
  return paramList;
}

function isHttp1x(version) {
  return version.toLowerCase().startsWith('http/1.')
}

function firstNonNegative(values) {
  for (var i = 0; i < values.length; ++i) {
    if (values[i] >= 0)
      return values[i];
  }
  return -1;
}