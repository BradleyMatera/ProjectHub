// api/chat.js
const { Configuration, OpenAIApi } = require("openai");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow CORS
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
  const openai = new OpenAIApi(config);
  const { message } = req.body;

  try {
    const response = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: message }],
      max_tokens: 50
    });
    res.status(200).json({ reply: response.data.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
};