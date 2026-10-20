const mockListenHttp = jest.fn(() => ({
  setTimeout: jest.fn(),
  on: jest.fn(),
}));
const mockListenHttps = jest.fn();
const mockWs = jest.fn();

jest.mock("../../../models/telemetry", () => ({ Telemetry: {} }));
jest.mock("../../../utils/BackgroundWorkers", () => ({
  BackgroundService: class {},
}));
jest.mock("../../../utils/EncryptionManager", () => ({
  EncryptionManager: class {},
}));
jest.mock("../../../utils/comKey", () => ({ CommunicationKey: class {} }));
jest.mock("../../../utils/telemetry", () => jest.fn());
jest.mock("../../../utils/boot/eagerLoadContextWindows", () => jest.fn());
jest.mock("../../../utils/boot/markOnboarded", () => jest.fn());
jest.mock("../../../utils/PushNotifications", () => ({
  PushNotifications: {},
}));
jest.mock("../../../utils/telegramBot", () => ({ TelegramBotService: {} }));
jest.mock("@mintplex-labs/express-ws", () => ({ default: mockWs }));
jest.mock("https", () => ({
  createServer: jest.fn(() => ({
    listen: mockListenHttps,
    setTimeout: jest.fn(),
    on: jest.fn(),
  })),
}));
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  readFileSync: jest.fn(() => "x"),
}));

const { bootHTTP, bootSSL } = require("../../../utils/boot");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));
const app = { listen: mockListenHttp };

beforeEach(() => jest.clearAllMocks());

test("HTTPS: express-ws sync, listen only after recovery resolves", async () => {
  const d = deferred();
  bootSSL(app, 3001, d.promise);
  expect(mockWs).toHaveBeenCalledTimes(1);
  await tick();
  expect(mockListenHttps).not.toHaveBeenCalled();
  d.resolve();
  await tick();
  expect(mockListenHttps).toHaveBeenCalledTimes(1);
});

test("HTTPS: listens after a settled (non-fatal) recovery too", async () => {
  bootSSL(app, 3001, Promise.resolve());
  await tick();
  expect(mockListenHttps).toHaveBeenCalledTimes(1);
});

test("HTTP chain: listen only after recovery resolves", async () => {
  const d = deferred();
  d.promise.then(() => bootHTTP(app, 3001));
  await tick();
  expect(mockListenHttp).not.toHaveBeenCalled();
  d.resolve();
  await tick();
  expect(mockListenHttp).toHaveBeenCalledTimes(1);
});

test("HTTPS fallback to HTTP also waits for recovery", async () => {
  const https = require("https");
  https.createServer.mockImplementationOnce(() => {
    throw new Error("bad cert");
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  const d = deferred();
  bootSSL(app, 3001, d.promise);
  await tick();
  expect(mockListenHttp).not.toHaveBeenCalled();
  d.resolve();
  await tick();
  expect(mockListenHttp).toHaveBeenCalledTimes(1);
});
