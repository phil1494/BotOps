import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy Supabase Admin Client
let supabaseAdmin: any = null;

const getSupabaseAdmin = () => {
  if (!supabaseAdmin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Server-side Supabase credentials (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are missing.");
    }
    supabaseAdmin = createClient(url, key);
  }
  return supabaseAdmin;
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // --- AUTH MIDDLEWARE ---
  const authenticateUser = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No authorization header" });

    const token = authHeader.split(" ")[1];
    const { data: { user }, error } = await getSupabaseAdmin().auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = user;
    next();
  };

  // --- API ROUTES ---

  /**
   * Endpoint: /api/add-bot
   * Purpose: Fetches Discord bot info and saves it to Supabase
   */
  app.post("/api/add-bot", authenticateUser, async (req: any, res) => {
    const { token } = req.body;
    const userId = req.user.id;
    if (!token) return res.status(400).json({ error: "Token is required" });

    try {
      // 1. Fetch from Discord API
      const botResponse = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });

      if (!botResponse.ok) throw new Error("Invalid Discord Token");
      const botData: any = await botResponse.json();

      // 2. Fetch Guild Count
      const appResponse = await fetch("https://discord.com/api/v10/applications/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      const appData: any = await appResponse.json();

      const botInfo = {
        id: botData.id,
        username: botData.username,
        avatar: botData.avatar,
        guild_count: appData.approximate_guild_count || 0,
        status: "online",
        token: token // Stored securely in Supabase
      };

      // Generate a deterministic UUID from the Discord ID
      const hash = crypto.createHash("md5").update(botInfo.id).digest("hex");
      const deterministicUuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-a${hash.slice(16, 19)}-${hash.slice(20, 32)}`;

      // 3. Save to Supabase
      const { data, error } = await getSupabaseAdmin()
        .from("cluster_stats")
        .upsert({
          id: deterministicUuid,
          name: `${botInfo.username}|${botInfo.id}`, // Store both username and Discord ID
          avatar_url: botInfo.avatar ? `https://cdn.discordapp.com/avatars/${botInfo.id}/${botInfo.avatar}.png` : null,
          guild_count: botInfo.guild_count,
          status: botInfo.status,
          user_id: userId
        })
        .select();

      if (error) throw error;

      res.json(data[0]);
    } catch (error: any) {
      console.error("Add Bot Error:", error);
      res.status(500).json({ error: error.message || "Failed to add bot" });
    }
  });

  /**
   * Endpoint: /api/bots
   * Purpose: Fetches all bots from Supabase
   */
  app.get("/api/bots", authenticateUser, async (req: any, res) => {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from("cluster_stats")
        .select("*")
        .eq("user_id", req.user.id);
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
