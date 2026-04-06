require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const cron = require('node-cron');
const oracledb = require('oracledb');
const twilio = require('twilio');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECT
};


// 🔥 CRON JOB (AUTO ALERT)
cron.schedule('*/2 * * * *', async () => {
  console.log("⏳ Running auto alert check...");

  let connection;

  try {
    connection = await oracledb.getConnection(dbConfig);

    await connection.execute(`BEGIN check_alerts; END;`);

    const result = await connection.execute(`
  SELECT a.alert_id, a.price, u.phone_number, p.name, p.url
  FROM alerts a
  JOIN users u ON a.user_id = u.user_id
  JOIN products p ON a.product_id = p.product_id
  WHERE a.sent = 0
`);

    for (let row of result.rows) {
  const alert_id = row[0];
  const price = row[1];
  const phone = row[2];
  const name = row[3];
  const url = row[4];

  await twilioClient.messages.create({
    body: `🔥 SALE ALERT!

📦 ${name.substring(0, 50)}

💰 Price: ₹${price}
🎯 Target reached!

🔗 ${url.substring(0, 60)}

⚡ Grab it now!`,
    from: process.env.TWILIO_FROM_NUMBER,
    to: phone
  });

  await connection.execute(
    `UPDATE alerts SET sent = 1 WHERE alert_id = :id`,
    { id: alert_id }
  );
}

    await connection.commit();

  } catch (err) {
    console.error("CRON ERROR:", err);
  } finally {
    if (connection) await connection.close();
  }
});


// 🔥 MAIN ROUTE
app.post('/run-python', (req, res) => {
  const { user_input, target_price, phone_number } = req.body;

  const py = spawn('python', [
    path.join(__dirname, 'webscrape.py'),
    user_input,
    target_price,
    phone_number
  ]);

  let output = '';

  py.stdout.on('data', (data) => {
    output += data.toString();
  });

  py.on('close', async () => {
    try {
      const json = JSON.parse(output);

      const connection = await oracledb.getConnection(dbConfig);

      // ✅ 1. INSERT USER
      await connection.execute(
        `MERGE INTO users u
         USING (SELECT :phone AS phone FROM dual) src
         ON (u.phone_number = src.phone)
         WHEN NOT MATCHED THEN
           INSERT (user_id, phone_number)
           VALUES (user_seq.NEXTVAL, src.phone)`,
        { phone: phone_number }
      );

      // ✅ 2. GET USER ID
      const userRes = await connection.execute(
        `SELECT user_id FROM users WHERE phone_number = :phone`,
        { phone: phone_number }
      );
      const user_id = userRes.rows[0][0];

      // ✅ 3. HANDLE PRODUCT
      let product_id;

      const existing = await connection.execute(
        `SELECT product_id FROM products WHERE url = :url`,
        { url: user_input.substring(0, 1000) }
      );

      if (existing.rows.length > 0) {
        product_id = existing.rows[0][0];
      } else {
        await connection.execute(
          `INSERT INTO products (product_id, name, url)
           VALUES (product_seq.NEXTVAL, :name, :url)`,
          {
            name: json.product_name || "Unknown",
            url: user_input.substring(0, 1000)
          }
        );

        const resProd = await connection.execute(
          `SELECT MAX(product_id) FROM products`
        );
        product_id = resProd.rows[0][0];
      }

      // ✅ 4. INSERT PRICE HISTORY
      await connection.execute(
        `INSERT INTO price_history (history_id, product_id, price, timestamp)
         VALUES (history_seq.NEXTVAL, :p, :price, SYSDATE)`,
        {
          p: product_id,
          price: json.price || 0
        }
      );

      // ✅ 5. INSERT TRACKING (NO DUPLICATES)
    const existingTrack = await connection.execute(
  `SELECT tracking_id FROM tracking 
   WHERE user_id = :u AND product_id = :p`,
  { u: user_id, p: product_id }
);

if (existingTrack.rows.length === 0) {
  await connection.execute(
    `INSERT INTO tracking (tracking_id, user_id, product_id, target_price)
     VALUES (tracking_seq.NEXTVAL, :u, :p, :t)`,
    {
      u: user_id,
      p: product_id,
      t: target_price
    }
  );
} else {
  // 🔥 UPDATE instead of duplicate insert
  await connection.execute(
    `UPDATE tracking 
     SET target_price = :t 
     WHERE user_id = :u AND product_id = :p`,
    {
      u: user_id,
      p: product_id,
      t: target_price
    }
  );
}

      await connection.commit();
      await connection.close();

      res.json({
        success: true,
        price: json.price,
        message: json.message || "Tracking started successfully",
        sent_sms: json.sent_sms || false
      });

    } catch (err) {
      console.error("DB ERROR:", err);
      res.status(500).json({ error: err.message });
    }
  });
});


// 🔥 HISTORY ROUTE
app.get('/history', async (req, res) => {
  try {
    const connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(`
      SELECT DISTINCT p.url, p.name,
             (SELECT price FROM price_history ph
              WHERE ph.product_id = p.product_id
              ORDER BY timestamp DESC
              FETCH FIRST 1 ROWS ONLY),
             t.target_price
      FROM tracking t
      JOIN products p ON t.product_id = p.product_id
    `);

    await connection.close();

    const data = result.rows.map(r => ({
      url: r[0],
      name: r[1],
      price: r[2],
      target: r[3]
    }));

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).send("DB Error");
  }
});


app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
