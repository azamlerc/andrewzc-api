// routes/chat.js
// POST /chat/hello, /chat/senza, /chat/railfan

import express from "express";
import { runChat, preloadChat } from "../chat/runtime.js";
import { helloChat } from "../chat/hello.js";
import { senzaChat } from "../chat/senza.js";
import { railfanChat } from "../chat/railfan.js";
import { requireAdminSession } from "./auth.js";
import { cleanError } from "./middleware.js";

export const chatRouter = express.Router();

export async function preloadChats() {
  return Promise.all([
    preloadChat(helloChat),
    preloadChat(senzaChat),
    preloadChat(railfanChat),
  ]);
}

function makeChatHandler(chatDefinition) {
  return async (req, res) => {
    const { history, message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing message" });
    }
    try {
      const result = await runChat(chatDefinition, Array.isArray(history) ? history : [], message.trim());
      return res.json(result);
    } catch (err) {
      console.error(`POST /chat/${chatDefinition.name} failed:`, err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  };
}

chatRouter.post("/hello",   makeChatHandler(helloChat));
chatRouter.post("/senza",   makeChatHandler(senzaChat));
chatRouter.post("/railfan", requireAdminSession, makeChatHandler(railfanChat));
// chatRouter.post("/interview", makeChatHandler(interviewChat)); // coming soon
