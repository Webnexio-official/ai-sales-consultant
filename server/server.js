import express from "express";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";

dotenv.config();

/* ---------------- SUPABASE ---------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


/* ---------------- EXPRESS ---------------- */
const app = express();
app.use(cors({
  origin: ["https://webnexio.in"],
  methods: ["GET", "POST"]
}));

/* ---------------- GEMINI ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ---------------- KNOWLEDGE ---------------- */
const knowledge = fs.readFileSync("../knowledge/data.txt", "utf8");

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
  res.send("AI Sales Consultant Server is Running");
});



/* =========================================================
   CREATE LEAD (DETERMINISTIC ENTRY POINT)
========================================================= */
app.post("/create-lead", async (req, res) => {
  try {
    console.log("CREATE LEAD BODY:", req.body);
    console.log(process.env.SUPABASE_URL);
    console.log(process.env.SUPABASE_KEY?.slice(0,10));


    const { name, email, company_name, website, industry, pain } = req.body;

    // Minimal validation
    if (!name || !email || !company_name) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 1️⃣ Insert Lead
    const { data: lead, error } = await supabase
      .from("leads")
      .insert([
        {
          name,
          email,
          company_name,
          website: website || null,
          industry: industry || null,
          service_interest: pain || null,
          status: "qualified"
        }
      ])
      .select()
      .single();

    if (error) {
      console.log("Lead insert error:", error);
      return res.status(500).json({ error: "Lead insert failed" });
    }

    console.log("Lead created:", lead.id);

    // 2️⃣ Create Enrichment Job
    await supabase.from("enrichment_jobs").insert([
      {
        lead_id: lead.id,
        status: "pending",
        attempts: 0
      }
    ]);

    console.log("Enrichment job created");

    res.json({ success: true });

  } catch (err) {
    console.log("CREATE LEAD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});



/* =========================================================
   CHAT ROUTE (ONLY CHAT, NOT LEAD CREATION)
========================================================= */
app.post("/chat", async (req, res) => {
  try {
    let { message, session_id } = req.body;

    if (!session_id) {
      session_id = crypto.randomUUID();
      await supabase.from("conversations").insert([{ session_id }]);
    }

    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("session_id", session_id)
      .single();

    const conversationId = conversation.id;

    await supabase.from("messages").insert([
      {
        conversation_id: conversationId,
        role: "user",
        content: message
      }
    ]);

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        maxOutputTokens: 150,
        temperature: 0.4
      }
    });

    const result = await model.generateContent(`
You are a professional AI Sales Assistant.

Keep answers:
- Under 80 words
- Maximum 3 sentences
- Clear and direct

User: ${message}
    `);

    const reply = result.response.text();

    await supabase.from("messages").insert([
      {
        conversation_id: conversationId,
        role: "assistant",
        content: reply
      }
    ]);

    res.json({ reply, session_id });

  } catch (err) {
    console.log("CHAT ERROR:", err);
    res.status(500).json({ reply: "AI error" });
  }
});



/* =========================================================
   HISTORY
========================================================= */
app.get("/history/:session_id", async (req, res) => {
  try {
    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("session_id", req.params.session_id)
      .single();

    if (!conversation) return res.json({ messages: [] });

    const { data: messages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true });

    res.json({ messages });

  } catch (err) {
    console.log("History error:", err);
    res.json({ messages: [] });
  }
});



/* =========================================================
   ENRICHMENT WORKER
========================================================= */
setInterval(async () => {
  try {

    const { data: jobs } = await supabase
      .from("enrichment_jobs")
      .select("*")
      .eq("status", "pending")
      .limit(3);

    if (!jobs || jobs.length === 0) return;

    for (const job of jobs) {

      console.log("Processing job:", job.id);

      await supabase
        .from("enrichment_jobs")
        .update({
          status: "processing",
          attempts: job.attempts + 1,
          last_attempt_at: new Date()
        })
        .eq("id", job.id);

      const { data: lead } = await supabase
        .from("leads")
        .select("*")
        .eq("id", job.lead_id)
        .single();

      if (!lead) continue;

      const domain = lead.website
        ? lead.website.replace("https://", "").replace("http://", "").replace("www.", "")
        : lead.company_name;

      let searchResults = null;

      try {
        const tavilyRes = await axios.post(
          "https://api.tavily.com/search",
          {
            api_key: process.env.TAVILY_API_KEY,
            query: `Company information about ${domain}. Industry, size, revenue, founder, location.`,
            include_answer: true
          }
        );

        searchResults = tavilyRes.data.answer;

      } catch (err) {
        console.log("Tavily failed");
      }

      if (!searchResults) {
        await supabase
          .from("enrichment_jobs")
          .update({ status: "failed" })
          .eq("id", job.id);
        continue;
      }

      await supabase.from("enrichment_data").insert([
        {
          lead_id: lead.id,
          ai_analysis: searchResults,
          linkedin_url: `https://linkedin.com/company/${domain}`
        }
      ]);

      await supabase
        .from("leads")
        .update({ status: "enriched" })
        .eq("id", lead.id);

      await supabase
        .from("enrichment_jobs")
        .update({ status: "completed" })
        .eq("id", job.id);

      console.log("Enrichment completed:", lead.email);
    }

  } catch (err) {
    console.log("Worker error:", err);
  }
}, 20000);



/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3001;

app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
