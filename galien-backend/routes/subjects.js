const express = require("express");
const pool = require("../config/database");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", auth, async (req, res) => {
  const subjects = await pool.query("SELECT * FROM subjects");
  res.json(subjects.rows);
});

router.post("/", auth, async (req, res) => {
  const { name } = req.body;
  await pool.query("INSERT INTO subjects (name) VALUES ($1)", [name]);
  res.json({ message: "Matière ajoutée" });
});

module.exports = router;
