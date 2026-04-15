// routes/chat.js
// POST /chat/hello, /chat/senza, /chat/railfan

import express from "express";
import { chat, preload } from "../agent.js";
import { helloBot } from "../agent-hello.js";
import { senzaBot } from "../agent-senza.js";
import { railfanBot } from "../agent-railfan.js";
import { requireAdminSession } from "./auth.js";
import { cleanError } from "./middleware.js";

export const chatRouter = express.Router();

export async function preloadBots() {
  return Promise.all([
    preload(helloBot),
    preload(senzaBot),
    preload(railfanBot),
  ]);
}

function makeChatHandler(bot) {
  return async (req, res) => {
    const { history, message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing message" });
    }
    try {
      const result = await chat(bot, Array.isArray(history) ? history : [], message.trim());
      return res.json(result);
    } catch (err) {
      console.error(`POST /chat/${bot.name} failed:`, err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  };
}

chatRouter.post("/hello",   makeChatHandler(helloBot));
chatRouter.post("/senza",   makeChatHandler(senzaBot));
chatRouter.post("/railfan", requireAdminSession, makeChatHandler(railfanBot));
// chatRouter.post("/interview", makeChatHandler(interviewBot)); // coming soon
