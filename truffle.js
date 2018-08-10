const connectionConfig = require('./scripts/frg-ethereum-runners/config/network_config.json');

module.exports = {
  networks: {
    ganacheUnitTest: connectionConfig.ganacheUnitTest,
    gethUnitTest: connectionConfig.gethUnitTest
  },
  mocha: {
    enableTimeouts: false
  }
};
