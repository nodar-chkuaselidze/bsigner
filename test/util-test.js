/*!
 * util-test.js - Utility tests.
 * Copyright (c) 2020, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const assert = require('bsert');
const trezorHelpers = require('../lib/device/trezorhelpers');

const stripped = [
  '3044022046e4a2913d1968c8d3cdb7e728d03c63f6bd9c2ecb0a461d08f64557a22c4cf5'
  + '02205327fca2b2258d3a083b3f565703416af3b89f975635ad6e12d2b8fd295c7e12'
];

const withHashType = [
  '3044022046e4a2913d1968c8d3cdb7e728d03c63f6bd9c2ecb0a461d08f64557a22c4cf5'
  + '02205327fca2b2258d3a083b3f565703416af3b89f975635ad6e12d2b8fd295c7e1201'
];

describe('Utils', function () { 
  it('should not strip when no hash type', () => {
    for (const sig of stripped)
      assert.equal(trezorHelpers.stripHashType(sig), sig);
  });

  it('should strip hash type', () => {
    for (const sig of withHashType)
      assert.equal(trezorHelpers.stripHashType(sig), sig.substr(0, sig.length - 2));
  });
});
