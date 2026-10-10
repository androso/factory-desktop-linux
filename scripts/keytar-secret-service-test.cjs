const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { app, safeStorage } = require('electron');

app.whenReady().then(async () => {
  if (process.env.FACTORY_SECRET_SERVICE_TEST !== '1') {
    throw new Error('Refusing Secret Service access. Set FACTORY_SECRET_SERVICE_TEST=1 only inside a dedicated test keyring session.');
  }
  if (process.env.FACTORY_SECRET_SERVICE_TEST_ISOLATED !== '1') {
    throw new Error('Refusing Secret Service access without explicit confirmation that this is an isolated test Secret Service session.');
  }
  const markerPath = process.env.FACTORY_SECRET_SERVICE_ISOLATION_MARKER;
  const testRoot = path.resolve(process.env.FACTORY_SECRET_SERVICE_TEST_ROOT ?? '');
  if (!markerPath || !testRoot || !path.isAbsolute(testRoot)) {
    throw new Error('Refusing Secret Service access without a wrapper-created disposable test root and D-Bus isolation marker.');
  }
  const resolvedMarker = path.resolve(markerPath);
  if (!resolvedMarker.startsWith(`${testRoot}${path.sep}`)) {
    throw new Error('The D-Bus isolation marker must be inside the disposable test root.');
  }
  const marker = fs.statSync(resolvedMarker);
  if (!marker.isFile() || (marker.mode & 0o077) !== 0) {
    throw new Error('The D-Bus isolation marker must be a regular file with mode 0600 or stricter.');
  }
  const markerBusAddress = fs.readFileSync(resolvedMarker, 'utf8').trim();
  if (!process.env.DBUS_SESSION_BUS_ADDRESS || markerBusAddress !== process.env.DBUS_SESSION_BUS_ADDRESS) {
    throw new Error('The current D-Bus session does not match the wrapper-created isolated session.');
  }
  const currentHome = path.resolve(process.env.HOME ?? '');
  if (!currentHome.startsWith(`${testRoot}${path.sep}`)) {
    throw new Error('The Secret Service test HOME is not inside the disposable test root.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage encryption is unavailable; refusing to test credential persistence.');
  }
  if (typeof safeStorage.getSelectedStorageBackend === 'function' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('Electron selected the basic_text backend; refusing credential tests.');
  }
  const modulePath = process.env.FACTORY_KEYTAR_MODULE_PATH;
  if (!modulePath) throw new Error('FACTORY_KEYTAR_MODULE_PATH is required');
  const keytar = require(path.resolve(modulePath));
  const service = 'Factory Desktop Linux Port Test';
  const account = `dummy-${crypto.randomUUID()}`;
  const dummySecret = `not-a-credential-${crypto.randomUUID()}`;
  let created = false;
  try {
    await keytar.setPassword(service, account, dummySecret);
    created = true;
    const retrieved = await keytar.getPassword(service, account);
    if (retrieved !== dummySecret) throw new Error('Secret Service returned an unexpected test value');
    console.log('SECRET_SERVICE_SET_GET_OK');
  } finally {
    if (created) {
      const removed = await keytar.deletePassword(service, account);
      if (!removed) throw new Error('Could not delete the dummy Secret Service entry');
      console.log('SECRET_SERVICE_DELETE_OK');
    }
  }
}).then(() => {
  app.quit();
}).catch((error) => {
  console.error(`SECRET_SERVICE_TEST_FAIL: ${error.message}`);
  process.exitCode = 1;
  app.quit();
});
