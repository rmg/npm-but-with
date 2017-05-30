'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const tar = require('tar');
const url = require('url');

const PORT = process.env.PORT || 4873;
const UPSTREAM =
  process.env.npm_config_registry || 'https://registry.npmjs.org';
const registry = makeProxy(UPSTREAM);
const NOW = new Date();

const upstreamGet = /^https:/.test(UPSTREAM) ? https.get : http.get;

const seeds = {};

addSeeds(process.argv.slice(2)).then(run).catch(err => {
  console.error('error:', err);
});

function addSeeds(tarballs) {
  console.log('Proxying to %s with local overlays:', UPSTREAM);
  return Promise.all(
    tarballs.map(tgzPath => processTarball(tgzPath).then(makeSeedResponders))
  );
}

function makeSeedResponders(seed) {
  const shasum = seed.shasum;
  const pkgJson = seed.pkgJson;
  const upstreamPkgJson = seed.upstreamPkgJson;
  const tgzSize = seed.tgzSize;
  const name = pkgJson.name;
  const version = pkgJson.version;
  const tgzName = `${name}-${version}.tgz`;
  const tgzPath = `/${name}/-/${tgzName}`;
  const metaPath = `/${name}`;
  if (upstreamPkgJson.versions[pkgJson.version]) {
    console.log(
      ' - %s@%s (upstream, %s)',
      name,
      version,
      upstreamPkgJson.versions[pkgJson.version].dist.shasum
    );
  }
  upstreamPkgJson.versions[pkgJson.version] = pkgJson;
  console.log(' + %s@%s (local, %s)', name, version, shasum);
  upstreamPkgJson['dist-tags'].latest = pkgJson.version;
  pkgJson.dist = {
    shasum: shasum,
    tarball: 'generate me when we know what Host header the client sent'
  };
  upstreamPkgJson.time.modified = upstreamPkgJson.time[version] = NOW;
  // accept requests with and without the trailing '/'
  seeds[metaPath] = seeds[metaPath + '/'] = function metaResponse(req, res) {
    pkgJson.dist.tarball = `http://${req.headers.host}${tgzPath}`;
    const body = Buffer.from(JSON.stringify(upstreamPkgJson));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': body.byteLength
    });
    res.end(body);
  };
  seeds[tgzPath] = function tarballResponse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'application/octet',
      'Content-Length': tgzSize
    });
    fs.createReadStream(seed.path).pipe(res);
  };
}

function processTarball(tgzName) {
  const tgzSize = sizeOf(tgzName);
  const shasum = shasumOf(tgzName);
  const pkgJson = extractPackageJson(tgzName);
  const upstreamPkgJson = pkgJson.then(json => {
    return new Promise((resolve, reject) => {
      const upstreamUrl = `${UPSTREAM}/${json.name}`;
      const req = upstreamGet(upstreamUrl, res => {
        const parts = [];
        res.on('data', chunk => {
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
    tgzSize
  ]).then(parts => {
    return {
      path: tgzName,
      shasum: parts[0],
      pkgJson: parts[1],
      upstreamPkgJson: parts[2],
      tgzSize: parts[3]
    };
  });
}

function extractPackageJson(tgzName) {
  return new Promise((resolve, reject) => {
    const tgzStream = fs.createReadStream(tgzName);
    tgzStream.pipe(
      new tar.Parse({ filter: onlyPackageJson, onentry: readPackageJson })
    );
    function readPackageJson(entry) {
      const bufs = [];
      entry.on('data', chunk => bufs.push(chunk)).on('end', () => {
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
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    hash.on('readable', () => {
      const data = hash.read();
      if (data) resolve(data.toString('hex'));
    });
    fs.createReadStream(filePath).pipe(hash);
    // TODO: 'error' on readStream and hash
  });
}

function sizeOf(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stat) => {
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
  http
    .createServer()
    .on('request', onRequest)
    .on('listening', onListen)
    .listen(PORT, '0.0.0.0');
}

function onListen() {
  console.log('Listening on http://0.0.0.0:%d', this.address().port);
  console.log('To use this registry:');
  console.log(
    ' - run `npm config set registry http://127.0.0.1:%d`',
    this.address().port
  );
  console.log(
    ' - or add `--registry=http://127.0.0.1:%d` to npm commands',
    this.address().port
  );
}

function onRequest(req, res) {
  req.started = process.hrtime();
  const seedResponder = seeds[req.url];
  if (seedResponder) {
    return seedResponder(req, res);
  }
  const up = registry(req);
  up.on('error', proxyError).on('response', proxyToRes);
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
      headers: headers
    };
    return req.pipe(proto.request(npmReqOpts));
  }
}
