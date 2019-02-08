#!/usr/bin/env node

'use strict';

const Config = require('bcfg');
const {Network,TX,MTX} = require('bcoin');
const {MultisigClient} = require('bmultisig-client');
const blgr = require('blgr');
const assert = require('bsert');
const {WalletClient} = require('bclient');

const {prepareTypes} = require('../src/common');
const {Path} = require('../src/path');
const {Hardware} = require('../src/hardware');
const {prepareSign,generateToken} = require('../src/app');

/*
 * TODO: if this.config is mutated, then things will break
 * add json flag for great cli foo
 */

class CLI {
  constructor() {
    this.config = new Config('harwarelib', {
      alias: {},
    });

    this.config.load({
      argv: true,
      env: true,
    });

    if (this.config.str('config'))
      this.config.open(this.config.path('config'));
  }

  async open() {
    this.logger = new blgr(this.config.str('loglevel', 'debug'));
    await this.logger.open();

    if (this.config.has('help')) {
      this.logger.info(this.help());
      process.exit(0);
    }

    const [valid, msg] = this.validateConfig();
    if (!valid) {
      this.logger.error(this.help(msg));
      process.exit(1);
    }

    const network = Network.get(this.config.str('network'));

    this.client = new MultisigClient({
      network: network.type,
      port: network.walletPort,
      apiKey: this.config.str('api-key'),
    });

    this.wallet = this.client.wallet(this.config.str('wallet'), this.config.str('token'));

    if (this.config.str('path'))
      this.path = Path.fromString(this.config.str('path'));
    else
      this.path = Path.fromOptions({
        network: network.type,
        purpose: this.config.uint('purpose', 44),
        account: this.config.uint('index', 0),
        // allow for custom coin paths
        coin: this.config.uint('coin'),
      });

    /*
     * get multisig wallet info
     */
    if (this.config.has('get-info')) {
      const info = await this.wallet.getInfo(true);
      if (!info)
        throw new Error('could not fetch wallet info');

      this.logger.info('wallet id: %s', info.id);
      this.logger.info('initialized: %s', info.initialized);
      if (info.initialized) {
        this.logger.info('receive address: %s', info.account.receiveAddress);
        this.logger.info('balance: %s', info.account.balance.confirmed);
      }
      process.exit(0);
    }

    /*
     * get proposals
     */
    if (this.config.has('get-proposals')) {
      const proposals = await this.wallet.getProposals(true);

      if (!proposals || proposals.length === 0)
        this.logger.info('no proposals found');

      for (const proposal of proposals)
        this.logger.info('\n%o', proposal);
      process.exit();
    }

    /*
     * initialize hardware
     */
    this.hardware = Hardware.fromOptions({
      vendor: this.config.str('vendor'),
      retry: this.config.bool('retry', true),
      network: network,
      logger: this.logger,
    });

    await this.hardware.initialize();

    /*
     * create multisig wallet
     */
    if (this.config.has('create-wallet')) {
      const cosignerToken = await generateToken(this.hardware, this.path);

      const hdpubkey = await this.hardware.getPublicKey(this.path);

      const response = await this.client.createWallet(this.config.str('wallet'), {
        witness: this.config.bool('segwit', false),
        xpub: hdpubkey.xpubkey(network.type),
        watchOnly: true,
        m: this.config.uint('m'),
        n: this.config.uint('n'),
        cosignerName: this.config.str('cosigner-name'),
        cosignerPath: this.path.toString(),
        cosignerToken: cosignerToken.toString('hex'),
      });

      this.logger.info('wallet created: %s - %s of %s', response.id, response.m, response.n);
      this.logger.info('join key: %s', response.joinKey);

      const cosigner = response.cosigners.find(c => c.name === this.config.str('cosigner-name'));
      this.logger.info('cosigner name/token: %s/%s', cosigner.name, cosigner.token);
    }

    if (this.config.has('join-wallet')) {
      const hdpubkey = await this.hardware.getPublicKey(this.path.toList());
      const cosignerToken = await generateToken(this.hardware, this.path);

      const join = await this.wallet.joinWallet({
        cosignerName: this.config.str('cosigner-name'),
        cosignerPath: this.path.toString(),
        joinKey: this.config.str('join-key'),
        xpub: hdpubkey.xpubkey(network.type),
        cosignerToken: cosignerToken.toString('hex'),
      });

      this.logger.info('wallet joined: %s - initialized: %s', join.id, join.initialized);
      const cosigner = join.cosigners.find(c => c.name === this.config.str('cosigner-name'));
      this.logger.info('cosigner name/token: %s/%s', cosigner.name, cosigner.token);
    }

    /*
     * create proposal
     */
    if (this.config.has('create-proposal')) {
      const hdpubkey = await this.hardware.getPublicKey(this.path.toString());
      const cosignerToken = await generateToken(this.hardware, this.path);

      const wallet = this.client.wallet(this.config.str('wallet'), cosignerToken.toString('hex'));
      const proposal = await wallet.createProposal({
        memo: this.config.str('memo'),
        cosigner: this.config.str('cosigner-id'),
        rate: this.config.uint('rate', 1e3),
        sign: false,
        account: this.config.str('account', 'default'),
        outputs: [
          {
            value: this.config.uint('value'),
            address: this.config.str('recipient'),
          },
        ],
      });

      this.logger.info('proposal id: %s', proposal.id);
      this.logger.info('%s', proposal.statusMessage);
    }


    if (this.config.has('approve-proposal')) {

      // think about moving this into the function...
      const pid = this.config.uint('proposal-id');
      const ptx = await this.wallet.getProposalMTX(pid, {
        paths: true,
        scripts: true,
      });

      if (!ptx.tx)
        throw new Error('no proposal to approve');


      const mtx = MTX.fromRaw(Buffer.from(ptx.tx.hex, 'hex'));

      const { coins, inputTXs, paths } = await prepareSign({
        wallet: this.wallet,
        tx: ptx.tx,
        paths: ptx.paths,
        account: this.config.uint('index'),
        network: network.type,
        purpose: this.config.uint('purpose', 44),
      });

      const scripts = ptx.scripts;

      const signature = await this.hardware.getSignature(mtx, {
        paths,
        inputTXs,
        coins,
        scripts,
        enc: 'hex',
      });

      if (!signature)
        throw new Error('problem signing transaction');

      const cosignerToken = await generateToken(this.hardware, this.path);

      const wallet = this.client.wallet(this.config.str('wallet'), cosignerToken.toString('hex'));
      const approval = await wallet.approveProposal(pid, [signature], this.config.bool('broadcase', true));

      this.logger.info('proposal id: %s', proposal.id);
      this.logger.info('approvals: %s', approval.approvals.length);
      this.logger.info('%s', approval.statusMessage);
    }

    if (this.config.str('reject-proposal')) {

      const cosignerToken = await generateToken(this.hardware, this.path);

      const wallet = this.client.wallet(this.config.str('wallet'), cosignerToken.toString('hex'));
      const rejection = await wallet.rejectProposal(this.config.uint('proposal-id'));

      this.logger.info('rejected proposal id: %s', rejection.id);
    }
  }

  async destroy() {
    await this.hardware.close();
  }

  /*
   * Checks that each required config
   * option is present
   * @returns {[]Boolean, String}
   */
  validateConfig() {
    let msg = '';
    let valid = true;

    if (this.config.has('get-info'))
      return [valid, msg];

    if (this.config.has('get-proposals'))
      return [valid, msg];

    if (!this.config.has('vendor')) {
      msg += 'must provide vendor\n';
      valid = false;
    }

    const network = this.config.str('network');
    if (!network) {
      msg += 'must provide network\n';
      valid = false;
    }

    if (!['main', 'testnet', 'regtest', 'simnet'].includes(network)) {
      msg += `invalid network: ${network}\n`
      valid = false;
    }

    // TODO: this may need a refactor
    if (!this.config.has('api-key'))
      this.logger.debug('no api key passed');
    if (!this.config.has('token'))
      this.logger.debug('no token passed');

    if (!this.config.has('wallet')) {
      msg += 'must provide wallet\n';
      valid = false;
    }

    // create wallet required config
    if (this.config.has('create-wallet')) {
      const m = this.config.uint('m');
      const n = this.config.uint('n');

      if (!m || !n) {
        msg += 'must pass m and n\n';
        valid = false;
      }

      if (!this.config.has('cosigner-name')) {
        msg += 'must pass cosigner name\n';
        valid = false;
      }
    }

    if (this.config.has('join-wallet')) {
      if (!this.config.str('join-key')) {
        msg += 'must pass join key\n';
        valid = false;
      }
      if (!this.config.has('wallet')) {
        msg += 'must pass wallet\n';
        valid = false;
      }
    }

    if (this.config.has('create-proposal')) {
      if (!this.config.str('memo')) {
        msg += 'must pass memo\n';
        valid = false;
      }

      if (!this.config.has('value')) {
        msg += 'must pass value\n';
        valid = false;
      }

      if (!this.config.has('recipient')) {
        msg += 'must pass recipient\n';
        valid = false;
      }
    }

    if (this.config.str('approve-proposal')) {
      if (!this.config.str('proposal-id')) {
        msg += 'must pass proposal id\n';
        valid = false;
      }
    }

    if (!this.config.has('path')) {
      if (!this.config.has('index')) {
        msg += 'must pass index\n';
        valid = false;
      }
    }

    if (!valid)
      msg = 'Invalid config\n' + msg;

    return [valid, msg];
  }

  help(msg = '') {
    return msg +'\n' +
      'multisig.js - manage multisig transactions using trezor and ledger\n' +
      '  --vendor           - ledger or trezor\n' +
      '  --get-info         - get multisig wallet info\n' +
      '    --wallet         - wallet id\n' +
      '    --token\n' +
      '  --get-proposals    - list wallet proposals\n' +
      '    --wallet         - wallet id\n' +
      '  --create-wallet    - create multisig wallet\n' +
      '    --wallet         - wallet id\n' +
      '    --m              - threshold to spend\n' +
      '    --n              - total number of cosigners\n' +
      '  --create-proposal  -\n' +
      '    --wallet         - wallet id\n' +
      '    --memo           - string description\n' +
      '    --recipient      - base58/bech32 encoded address\n' +
      '    --token\n' +
      '  --approve-proposal\n' +
      '    --proposal-id    - integer proposal id\n' +
      '    --index          - bip44 account index\n' +
      '';
  }
}

(async () => {
  const cli = new CLI();
  await cli.open();
  await cli.destroy();
})().catch(e => {
  console.error(e.stack);
  process.exit(1);
});

