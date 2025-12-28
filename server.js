const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicjalizacja tabeli (UPROSZCZONA - bez server_id, owner, expires)
pool.query(`
  CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    license_key TEXT UNIQUE NOT NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  console.log('✅ Tabela licenses gotowa');
}).catch(err => {
  console.error('❌ Błąd tabeli:', err);
});

// ============================================
// GŁÓWNE ENDPOINTY
// ============================================

// Root - Info o API
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    service: 'MnCraftCore License API',
    version: '1.0',
    endpoints: {
      generate: '/api/generate-key',
      verify: '/api/verify',
      licenses: '/api/licenses'
    }
  });
});

// Generuj klucz i ZAPISZ DO BAZY
app.get('/api/generate-key', async (req, res) => {
  try {
    const key = crypto.randomBytes(16).toString('hex').toUpperCase();
    
    // ZAPISZ DO BAZY!
    await pool.query(
      'INSERT INTO licenses (license_key, active) VALUES ($1, true)',
      [key]
    );
    
    console.log(`✅ Wygenerowano i zapisano: ${key}`);
    
    res.json({ 
      license_key: key,
      message: 'Klucz zapisany w bazie danych'
    });
    
  } catch (err) {
    console.error('❌ Błąd generowania:', err);
    res.status(500).json({ 
      error: err.message,
      hint: 'Sprawdź czy tabela licenses istnieje'
    });
  }
});

// Weryfikuj licencję (dla pluginu Minecraft)
app.post('/api/verify', async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.json({ 
        valid: false, 
        message: 'Brak klucza licencji' 
      });
    }

    console.log(`🔍 Sprawdzam klucz: ${license_key}`);

    const result = await pool.query(
      'SELECT * FROM licenses WHERE license_key = $1',
      [license_key]
    );

    if (result.rows.length === 0) {
      console.log(`❌ Klucz nie istnieje: ${license_key}`);
      return res.json({ 
        valid: false, 
        message: 'Licencja nie istnieje w systemie' 
      });
    }

    const license = result.rows[0];

    if (!license.active) {
      console.log(`🚫 Klucz nieaktywny: ${license_key}`);
      return res.json({ 
        valid: false, 
        message: 'Licencja została dezaktywowana' 
      });
    }

    console.log(`✅ Klucz zweryfikowany: ${license_key}`);
    
    res.json({ 
      valid: true, 
      message: 'Licencja aktywna',
      license_key: license.license_key
    });

  } catch (err) {
    console.error('❌ Błąd weryfikacji:', err);
    res.status(500).json({ 
      valid: false, 
      message: 'Błąd serwera: ' + err.message 
    });
  }
});

// Lista wszystkich licencji
app.get('/api/licenses', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT license_key, active, created_at FROM licenses ORDER BY created_at DESC'
    );
    
    console.log(`📋 Zwracam ${result.rows.length} licencji`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Błąd listy:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dezaktywuj licencję (admin)
app.post('/api/deactivate', async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: 'Brak klucza licencji' });
    }

    await pool.query(
      'UPDATE licenses SET active = false WHERE license_key = $1',
      [license_key]
    );

    console.log(`🚫 Dezaktywowano: ${license_key}`);
    res.json({ message: 'Licencja dezaktywowana' });

  } catch (err) {
    console.error('❌ Błąd:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reaktywuj licencję (admin)
app.post('/api/activate', async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: 'Brak klucza licencji' });
    }

    await pool.query(
      'UPDATE licenses SET active = true WHERE license_key = $1',
      [license_key]
    );

    console.log(`✅ Reaktywowano: ${license_key}`);
    res.json({ message: 'Licencja reaktywowana' });

  } catch (err) {
    console.error('❌ Błąd:', err);
    res.status(500).json({ error: err.message });
  }
});

// Usuń licencję (admin)
app.delete('/api/licenses/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const result = await pool.query(
      'DELETE FROM licenses WHERE license_key = $1',
      [key]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Licencja nie istnieje' });
    }

    console.log(`🗑️ Usunięto: ${key}`);
    res.json({ message: 'Licencja usunięta' });

  } catch (err) {
    console.error('❌ Błąd:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'healthy', 
      database: 'connected',
      time: result.rows[0].now
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: err.message 
    });
  }
});

// Start serwera
app.listen(PORT, () => {
  console.log(`🚀 API uruchomione na porcie ${PORT}`);
  console.log(`📍 Endpointy:`);
  console.log(`   GET  /api/generate-key - Generuj i zapisz klucz`);
  console.log(`   POST /api/verify - Weryfikuj licencję`);
  console.log(`   GET  /api/licenses - Lista licencji`);
});

process.on('SIGTERM', () => {
  console.log('⏹️ Zamykanie serwera...');
  pool.end();
  process.exit(0);
});
