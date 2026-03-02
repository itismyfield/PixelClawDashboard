import { Router } from "express";
import path from "node:path";
import fs from "node:fs";

const router = Router();
const SPRITE_DIR = path.join(process.cwd(), "public", "sprites");

// Serve sprite images
router.get("/sprites/:filename", (req, res) => {
  const filePath = path.join(SPRITE_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "not_found" });
  }
  res.sendFile(filePath);
});

export default router;
