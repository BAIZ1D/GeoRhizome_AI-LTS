/* eslint-env jest */
const fs = require("fs");
const path = require("path");

const SERVER = path.resolve(__dirname, "../..");
// Container-to-host URL defaults for reranker (8001), embedder (8000),
// hardware hub (8002) and LLM (8003) must not be loopback.
const FILES = [
  "utils/vectorDbProviders/lance/index.js",
  "utils/rerankerClient.js",
  "utils/chats/index.js",
  "utils/chats/embed.js",
  "utils/chats/agents.js",
  "utils/agents/index.js",
  "utils/agents/aibitat/plugins/web-browsing.js",
  "utils/EmbeddingEngines/genericOpenAi/index.js",
  "utils/AiProviders/genericOpenAi/index.js",
  "utils/agents/aibitat/providers/genericOpenAi.js",
  "endpoints/hardware.js",
];

describe("RET-06: no 127.0.0.1 fallbacks for host AI services", () => {
  it.each(FILES)("%s has no 127.0.0.1:800x default", (file) => {
    const src = fs.readFileSync(path.join(SERVER, file), "utf8");
    expect(src).not.toMatch(/["'`]https?:\/\/127\.0\.0\.1:800[0-3]/);
  });
});
