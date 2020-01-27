/*!
 * trezorhelpers.js - Trezor input transformations and other helpers.
 * Copyright (c) 2019, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const assert = require('bsert');
const scriptCommon = require('bcoin/lib/script/common');
const Network = require('bcoin/lib/protocol/network');
const consensus = require('bcoin/lib/protocol/consensus');
const HDPublicKey = require('bcoin/lib/hd/public');
const {Path} = require('../path');
const helpers = exports;

/**
 * Trezor only accepts main and testnets.
 * We can work around by using testnet for
 * everything other than Main.
 */

const networkMapping = {
  'main': 'Bitcoin',
  'testnet': 'Testnet',
  'regtest': null,
  'simnet': null
};

/**
 * Transform bcoin tx to trezor RefTransaction.
 * @see https://github.com/trezor/connect/blob/82a8c3d4/src/js/types/trezor.js#L156
 * @param {bcoin.TX} tx
 * @returns {Object}
 */

function txToTrezor(tx) {
  const trezorTX = {};

  trezorTX.hash = tx.txid().toString('hex');
  trezorTX.version = tx.version;
  trezorTX.lock_time = tx.locktime;

  trezorTX.inputs = [];

  for (const input of tx.inputs) {
    const trezorIn = {};

    trezorIn.prev_hash = input.prevout.txid().toString('hex');
    trezorIn.prev_index = input.prevout.index;
    trezorIn.sequence = input.sequence;
    trezorIn.script_sig = input.script.toRaw().toString('hex');

    trezorTX.inputs.push(trezorIn);
  }

  trezorTX.bin_outputs = [];

  for (const output of tx.outputs) {
    const trezorOut = {};

    trezorOut.amount = output.value;
    trezorOut.script_pubkey = output.script.toRaw().toString('hex');

    trezorTX.bin_outputs.push(trezorOut);
  }

  return trezorTX;
}

/**
 * Sort public keys and signatures.
 * @param {Object} - multisig trezor object.
 * @returns [Object[], String[]] - pubkeys and signatures sorted.
 */

function sortKeysAndSignatures(multisig, network) {
  const pubkeys = multisig.pubkeys.slice();
  const signatures = multisig.signatures.slice();

  const combined = pubkeys.map((v, i) => {
    return [v, signatures[i]];
  });

  combined.sort((a, b) => {
    const xpubA = HDPublicKey.fromBase58(a[0].xpub, network);
    const xpubB = HDPublicKey.fromBase58(b[0].xpub, network);

    const pkA = xpubA.derivePath(a[0].path).publicKey;
    const pkB = xpubB.derivePath(b[0].path).publicKey;

    return Buffer.compare(pkA, pkB);
  });

  const sortedPubkeys = [];
  const sortedSignatures = [];

  for (const pair of combined) {
    sortedPubkeys.push(pair[0]);
    sortedSignatures.push(pair[1]);
  }

  return [sortedPubkeys, sortedSignatures];
}

function processMultisigInputData(inputData) {
  assert(inputData.multisig, 'expected multisig in inputData.');

  const {multisig} = inputData;

  assert(Array.isArray(multisig.pubkeys));
  assert(Array.isArray(multisig.signatures));

  const pubkeys = multisig.pubkeys;
  const m = multisig.m;
  const n = pubkeys.length;

  assert(m <= n, 'M is more than N in multisig.');
  assert(n <= consensus.MAX_MULTISIG_PUBKEYS);
  assert(multisig.pubkeys.length === multisig.signatures.length,
    'pubkey and signature lengths are not same.');

  const [sortedPubkeys, sortedSignatures] = sortKeysAndSignatures(multisig);
  const signatures = [];

  // remove hash types.
  for (const sig of sortedSignatures)
    signatures.push(stripHashType(sig));

  const trezorMultisig = {
    m: m,
    pubkeys: [],
    signatures: signatures
  };

  for (const pubkey of sortedPubkeys) {
    const xpub = pubkey.xpub;
    const path = Path.fromString(pubkey.path);

    trezorMultisig.pubkeys.push({
      node: xpub,
      address_n: path.toList()
    });
  }

  return trezorMultisig;
}

/**
 * Process bcoin inputs -> trezor's TransactionInput.
 * Input types:
 *  - SPENDADDRESS = 0;     // standard P2PKH address
 *  - SPENDMULTISIG = 1;    // P2SH multisig address
 *  - EXTERNAL = 2;         // reserved for external inputs (coinjoin)
 *  - SPENDWITNESS = 3;     // native SegWit
 *  - SPENDP2SHWITNESS = 4; // SegWit over P2SH (backward compatible)
 * @param {bcoin.Input} input
 * @param {bcoin.Coin} coin
 * @param {Path} path
 * @param {bcoin.Script} script - redeem script
 * @param {BufferMap<PrevoutHash, bcoin.TX>} refTXs
 * @returns {Object}
 */

function processTrezorInputs(input, coin, inputData, refTXs) {
  const trezorInput = {
    prev_index: -1,
    prev_hash: null,
    sequence: 0,
    script_type: null
  };

  trezorInput.prev_hash = input.prevout.txid();
  trezorInput.prev_index = input.prevout.index;
  trezorInput.sequence = input.sequence;

  if (!inputData || !inputData.path || !coin) {
    // @see https://github.com/trezor/trezor-firmware/issues/38
    throw new Error('External inputs are not supported.');
    // trezorInput.script_type = 'EXTERNAL';
    // return trezorInput;
  }

  const path = inputData.path;

  assert(coin, 'must provide coin.');

  if (path)
    trezorInput.address_n = path.toList();

  trezorInput.amount = String(coin.value);
  const coinType = coin.getType();
  const prevoutHash = input.prevout.txid();

  let type;
  let legacy = false;
  let multisig = false;

  switch (coinType) {
    case 'pubkey': {
      throw new Error('Not implemented.');
    }
    case 'pubkeyhash': {
      legacy = true;
      type = 'SPENDADDRESS';
      break;
    }

    case 'witnesspubkeyhash': {
      type = 'SPENDWITNESS';
      break;
    }

    case 'witnessscripthash': {
      type = 'SPENDWITNESS';
      multisig = true;
      break;
    }

    case 'scripthash': {
      if (!inputData.witness) {
        legacy = true;
        multisig = true;
        type = 'SPENDMULTISIG';
        break;
      }

      // nested p2wpkh or p2wsh
      type = 'SPENDP2SHWITNESS';

      // nested p2wsh
      if (inputData.multisig)
        multisig = true;

      break;
    }

    default: {
      throw new Error('Can not figure out input type.');
    }
  }

  assert(type, 'Could not determine type.');
  trezorInput.script_type = type;

  let refTX = null;

  if (legacy) {
    assert(refTXs.has(prevoutHash), 'reference transaction required.');
    refTX = refTXs.get(prevoutHash);
  }

  if (multisig)
    trezorInput.multisig = processMultisigInputData(inputData);

  return {
    trezorInput,
    refTX
  };
}

/**
 * Prepare trezor outputs.
 * TODO: Add change path verification. (Verify on the trezor)
 * Output types:
 *  - PAYTOADDRESS = 0;     // string address output; change is a P2PKH address
 *  - PAYTOMULTISIG = 2;    // change output is a multisig address
 *  - PAYTOOPRETURN = 3;    // op_return
 *  - PAYTOWITNESS = 4;     // change output is native SegWit
 *  - PAYTOP2SHWITNESS = 5; // change output is SegWit over P2SH
 * @param {bcoin.Output} output
 * @param {bcoin.Network} network
 * @returns {Object}
 */

function processTrezorOutputs(output, network) {
  const trezorOutput = {};
  const outType = output.getType();

  trezorOutput.amount = String(output.value);

  let type;
  let addr;

  // NOTE:
  //  Do we use PAYTOMULTISIG in case of Legacy P2SH multisig: yes.
  //  Do we PAYTOWITNESS in case of nested (p2wpkh and p2wsh): ??.
  //  CHANGE processing.
  switch (outType) {
    case 'pubkey': {
      addr = output.getAddress();
      assert(addr, 'Could not get the address.');
      type = 'PAYTOADDRESS';
      break;
    }
    case 'pubkeyhash': {
      addr = output.getAddress();
      assert(addr, 'Could not get the address.');
      type = 'PAYTOADDRESS';
      break;
    }
    case 'scripthash': {
      addr = output.getAddress();
      assert(addr, 'Could not get the address.');
      type = 'PAYTOADDRESS';
      break;
    }
    case 'multisig': {
      throw new Error('Not implemented.');
    }
    case 'nulldata': {
      throw new Error('Not implemented.');
      // trezorOut.op_return_data = ...;
    }
    case 'witnesspubkeyhash': {
      addr = output.getAddress();
      assert(addr, 'Could not get the address.');
      type = 'PAYTOWITNESS';
      break;
    }
    case 'witnessscripthash': {
      addr = output.getAddress();
      assert(addr, 'Could not get the address.');
      type = 'PAYTOWITNESS';
      break;
    }
    default: {
      throw new Error('Could not determine the output type.');
    }
  }

  trezorOutput.script_type = type;

  if (addr)
    trezorOutput.address = addr.toString(network);

  return trezorOutput;
}

/**
 * Accumulate transactions in map, to make it
 * easier to select from.
 * @param {Object[]} inputData
 * @returns {Map<txid, TX>}
 */

function collectInputTXs(inputData) {
  const refTransactions = new Map();

  for (const data of inputData.values()) {
    const hash = data.prevTX.txid();
    refTransactions.set(hash, data.prevTX);
  }

  return refTransactions;
}

/**
 * Prepare trezor device request.
 * @param {TX} tx
 * @param {Path[]} paths
 * @param {Script[]} scripts
 * @param {Network} network
 * @returns {Object}
 */

helpers.createTrezorInputs = function createTrezorInputs(tx, inputData, network) {
  let trezorCoinName = networkMapping[network.type];

  // Signing itself does not care about address prefix,
  // instead of throwing we just assume network = 'testnet'

  if (!trezorCoinName) {
    network = Network.get('testnet');
    trezorCoinName = networkMapping['testnet'];
  }

  const signRequest = {
    inputs: [],
    outputs: [],
    coin: trezorCoinName,
    refTxs: []
  };

  signRequest.version = tx.version;
  signRequest.lock_time = tx.locktime;
  signRequest.inputs_count = tx.inputs.length;
  signRequest.outputs_count = tx.outputs.length;

  const refTXs = collectInputTXs(inputData);

  for (const input of tx.inputs) {
    const poKey = input.prevout.toKey();
    const data = inputData.get(poKey);
    const coin = data.coin;
    const {
      trezorInput,
      refTX
    } = processTrezorInputs(input, coin, data, refTXs);

    if (refTX) {
      const trezorTX = txToTrezor(refTX);
      signRequest.refTxs.push(trezorTX);
    }

    signRequest.inputs.push(trezorInput);
  }

  for (const output of tx.outputs) {
    const trezorOutput = processTrezorOutputs(output, network);
    signRequest.outputs.push(trezorOutput);
  }

  return signRequest;
};

/**
 * Get signature without sighash.
 * @param {String} signature - with or without sighash type.
 * @returns {String} signature without sighash type.
 */

function stripHashType(sigstr) {
  if (sigstr === '')
    return '';

  const signature = Buffer.from(sigstr, 'hex');

  if (scriptCommon.isSignatureEncoding(signature))
    return signature.slice(0, -1).toString('hex');

  const withHashType = Buffer.alloc(signature.length + 1);

  signature.copy(withHashType);

  withHashType[withHashType.length - 1] = scriptCommon.hashType.ALL;

  assert(scriptCommon.isSignatureEncoding(withHashType));

  return sigstr;
};