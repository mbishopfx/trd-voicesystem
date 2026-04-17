import express from "express";
import { openOpenClawTab } from "./openclawBridge.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

app.post("/wake", async (req, res) => {
  const phrase = String(req.body?.phrase || req.body?.text || "").trim();
  if (!phrase) {
    return res.status(400).json({ ok: false, error: "Missing phrase" });
  }

  try {
    await openOpenClawTab();
    return res.json({ ok: true, opened: true, phrase });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

const port = Number(process.env.OPENCLAW_WAKE_PORT || 4337);
app.listen(port, () => {
  console.log(`[voice-wake-server] listening on ${port}`);
});
