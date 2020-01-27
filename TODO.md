- Trezor `coin` for each request.
- Figure out a way to remove (PATH Unknown)
- FIGURE OUT Error: throw ERROR.INVALID_STATE;
- Test cases for tx signing (same as bledger)
  - With external input
  - P2PKH
  - P2SH
  - P2WPKH
  - P2WSH
  - NULLDATA Support

## BCOIN Improvement
 Sign transaction but return the signature w/o templating
 A way to extract signature from script ?

## Input Updates
There are some changes to the inputs that we accept for signing,
the structure can be fully explored in Generating test transaction(below).

Main reason for this change is coming from trezor multisig requirements. Trezor
accepts XPUB + m + derivePath for each XPUB as an input for signing
multisig transactions, so we have to provide those for trezor. Because
bsigner wants to create similar interface for other HW devices(Ledger),
ledger wil also swith to using these inputs instead.


## Generating test transactions

We expect specific `seed` to be available on the
device for running tests, this allows us to generate
deterministic tests, and this script tries to
generate those test cases.

Script will return `json` structure, which contains all necessary
information for signing from hardware.
Currently this will be used to test bsigner without
relying on the wallet and templated inputs.

If we only relied on wallet, we could omit some parameters,
but if there was need to use without wallet generated
transactions, or somehow stripped transactions (e.g. PSBT)
we would not be able to sign those.

Current JSON structure looks like:
```json5
{
  "description": "Signing vectors for HW devices.",
  "network": "regtest",
  "vectors": [
    {
      "description": "P2PKH",
      "tx": "hex serialized transaction",
      "inputTXs": [
        "hex serialized previous transactions"
      ],
      // Coins can be recovered using inputTXs, but for segwit transactions
      // you can omit inputTXs and instead only rely on `coins`.
      "coins": [
        {
          "version": 1,
          "height": -1,
          "value": 99997730,
          "script": "76a9143a2d4145a4f098523b3e8127f1da87cfc55b8e7988ac",
          "address": "16JcQVoL61QsLCPS6ek8UJZ52eRfaFqLJt",
          "coinbase": false,
          "hash": "670037dee35589aea887eefbe66f51de3aa0aa877ae1bd2d381e62b908a534a7",
          "index": 0
        }
      ],
      // This is mapping for each input, if input does not need signing we use `null`.
      "inputData": [
        { // P2PKH input
          "path": "m/44'/1'/0'/0/0",
          "witness": false
        }, 
        { // witness P2WPKH input (nested or not)
          "path": "m/44'/1'/0'/0/0",
          "witness": true
        },
        { // multisig input
          "path": "m/44'/1'/1'/0/1",
          "witness": false,
          "multisig":  {
            "m": 2,
            "pubkeys": [{
              "xpub": "xpub66...",
              "path":  "m/0/1"
            }, {
              "xpub": "xpub...",
              "path": "m/0/2"
            }],
            "signatures": [ "hex serialized signature", null]
          }
        },
        null // input that we don't need to sign.
      ]
    }
  ]
}
```
