const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: "sk-123" });
console.log(typeof openai.responses);
console.log(typeof openai.chat.completions);
