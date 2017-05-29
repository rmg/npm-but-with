# npm-but-with

Give me an npm registry, but with my-package-1.2.3.tgz published to it:

```sh
$ npm i -g npm-but-with
$ npm-but-with my-package-1.2.3.tgz
No serving https://registry.npmjs.org with following changes:
 - my-package@1.2.3 (upstream)
 + my-package@1.2.3 (local)
Available as: http://127.0.0.1:40511/
```

This is essentially a standalone re-implementation of one of the use-cases of
[strongloop/ephemeral-npm:nginx](https://github.com/strongloop/ephemeral-npm/pull/7).

TODO:
 - make this README.md true!
