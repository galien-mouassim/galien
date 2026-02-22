const express = require("express");
const pool = require("../config/database");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", auth, async (req, res) => {
  const { score, mode } = req.body;
  await pool.query(
    "INSERT INTO results (user_id, score, mode) VALUES ($1, $2, $3)",
    [req.user.id, score, mode]
  );
  res.json({ message: "Résultat enregistré" });
});

router.get("/me", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM results WHERE user_id=$1",
    [req.user.id]
  );
  res.json(r.rows);
});

module.exports = router;
