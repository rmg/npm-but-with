'use strict';

var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var https = require('https');
var tar = require('tar');
var url = require('url');

const PORT = process.env.PORT || 4873;
const UPSTREAM = process.env.npm_config_registry || 'https://registry.npmjs.org';
const registry = makeProxy(UPSTREAM);

const upstreamGet = /^https:/.test(UPSTREAM) ? https.get : http.get;

var seeds = {};

return addSeeds(process.argv.slice(2)).then(run).catch((err) => {
  console.error('error:', err);
});

function addSeeds(tarballs) {
  return Promise.all(tarballs.map(function(tgzPath) {
    console.log('tarball:', tgzPath);
    return processTarball(tgzPath).then(makeSeedResponders);
  }));
}

function makeSeedResponders(seed) {
  var shasum = seed.shasum;
  var pkgJson = seed.pkgJson;
  var upstreamPkgJson = seed.upstreamPkgJson;
  var tgzSize = seed.tgzSize;
  var name = pkgJson.name;
  var version = pkgJson.version;
  var tgzName = `${name}-${version}.tgz`;
  var tgzPath = `/${name}/-/${tgzName}`;
  var metaPath = `/${name}`;
  upstreamPkgJson.versions[pkgJson.version] = pkgJson;
  upstreamPkgJson['dist-tags'].latest = pkgJson.version;
  pkgJson.dist = {
    shasum: shasum,
    tarball: 'TBD',
  };
  upstreamPkgJson.time.modified = upstreamPkgJson.time[version] = (new Date()).toJSON();
  console.log(upstreamPkgJson);
  seeds[metaPath] = seeds[`${metaPath}/`] = function metaResponse(req, res) {
    pkgJson.dist.tarball = `http://${req.headers.host}${tgzPath}`;
    var body = Buffer.from(JSON.stringify(upstreamPkgJson));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  };
  seeds[tgzPath] = function tarballResponse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'application/octet',
      'Content-Length': tgzSize,
    });
    fs.createReadStream(seed.path).pipe(res);
  };
}

function processTarball(tgzName) {
  var tgzSize = sizeOf(tgzName);
  var shasum = shasumOf(tgzName);
  var pkgJson = extractPackageJson(tgzName);
  var upstreamPkgJson = pkgJson.then((json) => {
    return new Promise(function(resolve, reject) {
      var upstreamUrl = `${UPSTREAM}/${json.name}`;
      console.log('fetching:', upstreamUrl);
      var req = upstreamGet(upstreamUrl, (res) => {
        var parts = [];
        res.on('data', (chunk) => {
          parts.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
    });
  });
  return Promise.all([
    shasum,
    pkgJson,
    upstreamPkgJson,
    tgzSize,
  ]).then((parts) => {
    return {
      path: tgzName,
      shasum: parts[0],
      pkgJson: parts[1],
      upstreamPkgJson: parts[2],
      tgzSize: parts[3],
    };
  });
}

function extractPackageJson(tgzName) {
  return new Promise(function(resolve, reject) {
    var tgzStream = fs.createReadStream(tgzName);
    tgzStream.pipe(new tar.Parse({filter: onlyPackageJson, onentry: readPackageJson}));
    function readPackageJson(entry) {
      var bufs = [];
      entry.on('data', function(chunk) {
        bufs.push(chunk);
      }).on('end', function() {
        try {
          resolve(JSON.parse(Buffer.concat(bufs).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    }
  });
}

function shasumOf(filePath) {
  return new Promise(function(resolve, reject) {
    const hash = crypto.createHash('sha1');
    hash.on('readable', () => {
      const data = hash.read();
      if (data)
        resolve(data.toString('hex'));
    });
    fs.createReadStream(filePath).pipe(hash);
    // TODO: 'error' on readStream and hash
  });
}

function sizeOf(filePath) {
  return new Promise(function(resolve, reject) {
    fs.stat(filePath, function(err, stat) {
      if (err) {
        reject(err);
      } else {
        resolve(stat.size);
      }
    });
  });
}

function onlyPackageJson(path, entry) {
  return path === 'package/package.json';
}

function run() {
  http.createServer()
      .on('request', onRequest)
      .on('listening', onListen)
      .listen(PORT, '0.0.0.0');
}

function onListen() {
  console.log('listening on ', this.address());
}

function onRequest(req, res) {
  req.started = process.hrtime();
  var seedResponder = seeds[req.url];
  if (seedResponder) {
    return seedResponder(req, res);
  }
  var up = registry(req);
  up.on('error', proxyError)
    .on('response', proxyToRes);
  console.log(req.method, req.url);

  function proxyToRes(src) {
    // console.log('response: %s %s => %s', req.method, req.url, src.statusCode, src.headers);
    res.writeHead(src.statusCode, src.headers);
    src.pipe(res);
  }

  function proxyError(err) {
    console.error('error doing %s %s', req.method, req.url, err);
    res.writeHead(500, err.message);
    res.end(err.stacktrace);
  }
}

function makeProxy(upstream) {
  upstream = url.parse(upstream);
  const port = upstream.port || (/^https/.test(upstream.protocol) ? 443 : 80);
  const hostname = upstream.hostname;
  const proto = /^https/.test(upstream.protocol) ? https : http;
  return request;

  function request(req) {
    var headers = JSON.parse(JSON.stringify(req.headers));
    delete headers['host'];
    delete headers['connection'];
    delete headers['if-none-match'];
    var npmReqOpts = {
      hostname: hostname,
      port: port,
      path: req.url,
      method: req.method,
      headers: headers,
    };
    return req.pipe(proto.request(npmReqOpts));
  }
}
