const path = require('node:path');

try {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('This check must run in Electron Node mode.');
  }
  const modulePath = process.env.FACTORY_KEYTAR_MODULE_PATH;
  if (!modulePath) throw new Error('FACTORY_KEYTAR_MODULE_PATH is missing');
  const keytar = require(path.resolve(modulePath));
  for (const method of ['getPassword', 'setPassword', 'deletePassword']) {
    if (typeof keytar[method] !== 'function') throw new Error(`keytar.${method} is unavailable`);
  }
  console.log(`KEYTAR_LOAD_OK electron=${process.versions.electron} modules=${process.versions.modules}`);
} catch (error) {
  console.error(`KEYTAR_LOAD_FAIL: ${error.message}`);
  process.exitCode = 1;
}
