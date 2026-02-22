# Galien App

Plateforme QCM pour revision (entrainement + examen) avec panneau admin.

## Stack
- Frontend: HTML, CSS, JavaScript (vanilla)
- Backend: Node.js, Express
- Database: PostgreSQL

## Project Structure
- `galien-frontend/`: pages UI (`index.html`, `login.html`, `dashboard.html`, `qcm.html`, `profile.html`, `admin.html`, etc.)
- `galien-backend/`: API Express, auth, import CSV, stats, comments, favoris, etc.

## Prerequisites
- Node.js 18+
- PostgreSQL 14+

## Backend Setup
1. Go to backend folder:
```bash
cd galien-backend
```
2. Install dependencies:
```bash
npm install
```
3. Create/edit `.env`:
```env
PORT=5000
DB_USER=postgres
DB_PASSWORD=your_password
DB_HOST=localhost
DB_PORT=5432
DB_DATABASE=galien
JWT_SECRET=change_me
```
4. Start server:
```bash
npm start
```

Notes:
- Server runs on `http://localhost:5000`
- API base URL used by frontend: `http://localhost:5000/api`
- Admin account is auto-created on boot (if missing):
  - email: `admin@galien.com`
  - password: `admin123`

## Frontend Setup
You can open `galien-frontend/login.html` directly, or serve frontend with a static server.

Recommended:
```bash
cd galien-frontend
npx serve .
```

Then open the provided local URL.

## Real-World Test (Public URL)
Recommended quick setup: deploy backend + frontend together as one Render Web Service.

1. Push latest code to GitHub.
2. On Render, create a PostgreSQL database.
3. Create a **Web Service** from this repo.
4. Configure:
```txt
Root Directory: (leave empty / repo root)
Build Command: npm --prefix galien-backend install
Start Command: npm --prefix galien-backend start
```
5. Add environment variables in Render:
```env
PORT=10000
DB_USER=<from Render Postgres>
DB_PASSWORD=<from Render Postgres>
DB_HOST=<from Render Postgres>
DB_PORT=<from Render Postgres>
DB_DATABASE=<from Render Postgres>
JWT_SECRET=<strong-random-secret>
```
6. Deploy, then open:
```txt
https://<your-service>.onrender.com/login.html
```

Notes:
- Frontend is served by Express in production.
- API auto-uses same domain in production (`/api`), so no manual API URL edits are needed.
- Health endpoint: `GET /health`

## Main Features
- Training and exam modes
- Timer and correction systems
- Module/course/source filters
- Favorites, notes, comments, reports
- Profile with stats and history
- Admin management + CSV bulk import

## CSV Import (Admin)
Expected columns include:
- `question`
- `option_a` to `option_e`
- `correct_option` (example: `A` or `A,B,D`)
- `module_id`
- `course_id` or `course_name`
- `source_id` or `source_name`
- `explanation` (optional)

## Git Workflow
After local changes:
```bash
git add .
git commit -m "your message"
git push
```

## Security
- Do not commit `.env` or secrets.
- `.gitignore` is already configured for this project.
