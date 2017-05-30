# npm-but-with

Give me an npm registry, but with my-package-1.2.3.tgz published to it:

```sh
$ npm i -g npm-but-with
$ npm-but-with my-package-1.2.3.tgz
Proxying to https://registry.npmjs.org with local overlays:
 + my-package@1.2.3 (local, 5cad5b9850431ba05a0ba207f9553d1fd99d6056)
Listening on http://0.0.0.0:4873
To use this registry:
 - run `npm config set registry http://127.0.0.1:4873`
 - or add `--registry=http://127.0.0.1:4873` to npm commands
```

This is essentially a standalone re-implementation of one of the use-cases of
[strongloop/ephemeral-npm:nginx](https://github.com/strongloop/ephemeral-npm/pull/7).
