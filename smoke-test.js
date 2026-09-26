const fs=require("fs");
const required=["server.js","schema.sql","README.md","API.md","package.json","render.yaml",".env.example","public/index.html","public/app.js","public/app.css"];
for(const f of required) if(!fs.existsSync(f)) throw new Error(`Missing ${f}`);
console.log("Project file smoke test passed.");
