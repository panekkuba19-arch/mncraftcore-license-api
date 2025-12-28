// server.js - Główny plik serwera
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicjalizacja bazy danych
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255) UNIQUE NOT NULL,
                owner VARCHAR(255) NOT NULL,
                email VARCHAR(255),
                status VARCHAR(50) DEFAULT 'ACTIVE',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                max_servers INTEGER DEFAULT 1,
                last_check TIMESTAMP,
                reason TEXT
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS license_servers (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255) REFERENCES licenses(license_key),
                server_id VARCHAR(255) NOT NULL,
                server_ip VARCHAR(100),
                server_port INTEGER,
                plugin_version VARCHAR(50),
                minecraft_version VARCHAR(50),
                online_players INTEGER DEFAULT 0,
                max_players INTEGER DEFAULT 0,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(license_key, server_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS license_logs (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255),
                action VARCHAR(100),
                details TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ Baza danych zainicjalizowana');
    } catch (error) {
        console.error('❌ Błąd inicjalizacji bazy:', error);
    } finally {
        client.release();
    }
}

// Logowanie akcji
async function logAction(licenseKey, action, details) {
    try {
        await pool.query(
            'INSERT INTO license_logs (license_key, action, details) VALUES ($1, $2, $3)',
            [licenseKey, action, details]
        );
    } catch (error) {
        console.error('Błąd logowania:', error);
    }
}

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'MncraftCore License API',
        version: '1.0.0'
    });
});

// Walidacja licencji
app.post('/api/license/validate', async (req, res) => {
    const { license_key, server_id, server_ip, server_port, plugin_version, minecraft_version, online_players, max_players } = req.body;

    if (!license_key || !server_id) {
        return res.status(400).json({ valid: false, error: 'Brak wymaganych danych' });
    }

    try {
        const licenseResult = await pool.query(
            'SELECT * FROM licenses WHERE license_key = $1',
            [license_key]
        );

        if (licenseResult.rows.length === 0) {
            await logAction(license_key, 'VALIDATE_FAILED', 'Licencja nie znaleziona');
            return res.status(404).json({ valid: false, error: 'Licencja nie znaleziona' });
        }

        const license = licenseResult.rows[0];

        if (license.status !== 'ACTIVE') {
            await logAction(license_key, 'VALIDATE_FAILED', `Status: ${license.status}`);
            return res.status(403).json({
                valid: false,
                active: false,
                status: license.status,
                reason: license.reason || 'Licencja nieaktywna'
            });
        }

        if (license.expires_at && new Date(license.expires_at) < new Date()) {
            await pool.query(
                'UPDATE licenses SET status = $1 WHERE license_key = $2',
                ['EXPIRED', license_key]
            );
            await logAction(license_key, 'VALIDATE_FAILED', 'Licencja wygasła');
            return res.status(403).json({ valid: false, error: 'Licencja wygasła' });
        }

        const serverCount = await pool.query(
            'SELECT COUNT(*) FROM license_servers WHERE license_key = $1',
            [license_key]
        );

        const existingServer = await pool.query(
            'SELECT * FROM license_servers WHERE license_key = $1 AND server_id = $2',
            [license_key, server_id]
        );

        if (existingServer.rows.length === 0 && parseInt(serverCount.rows[0].count) >= license.max_servers) {
            await logAction(license_key, 'VALIDATE_FAILED', 'Przekroczony limit serverów');
            return res.status(403).json({ valid: false, error: 'Przekroczony limit serverów' });
        }

        await pool.query(`
            INSERT INTO license_servers 
            (license_key, server_id, server_ip, server_port, plugin_version, minecraft_version, online_players, max_players, last_seen)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
            ON CONFLICT (license_key, server_id) 
            DO UPDATE SET 
                server_ip = $3,
                server_port = $4,
                plugin_version = $5,
                minecraft_version = $6,
                online_players = $7,
                max_players = $8,
                last_seen = CURRENT_TIMESTAMP
        `, [license_key, server_id, server_ip, server_port, plugin_version, minecraft_version, online_players, max_players]);

        await pool.query(
            'UPDATE licenses SET last_check = CURRENT_TIMESTAMP WHERE license_key = $1',
            [license_key]
        );

        await logAction(license_key, 'VALIDATE_SUCCESS', `Server: ${server_id}`);

        res.json({
            valid: true,
            active: true,
            status: license.status,
            owner: license.owner,
            expires: license.expires_at
        });

    } catch (error) {
        console.error('Błąd walidacji:', error);
        res.status(500).json({ valid: false, error: 'Błąd serwera' });
    }
});

// Check status
app.post('/api/license/check', async (req, res) => {
    const { license_key } = req.body;

    if (!license_key) {
        return res.status(400).json({ error: 'Brak klucza licencji' });
    }

    try {
        const result = await pool.query(
            'SELECT status, reason, expires_at FROM licenses WHERE license_key = $1',
            [license_key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Licencja nie znaleziona' });
        }

        const license = result.rows[0];
        const active = license.status === 'ACTIVE' && 
                      (!license.expires_at || new Date(license.expires_at) > new Date());

        res.json({
            active: active,
            status: license.status,
            reason: license.reason || '',
            expires: license.expires_at
        });

    } catch (error) {
        console.error('Błąd sprawdzania statusu:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// Utworzenie licencji
app.post('/api/admin/license/create', async (req, res) => {
    const { license_key, owner, email, expires_at, max_servers } = req.body;
    const adminKey = req.headers['x-admin-key'];

    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Brak autoryzacji' });
    }

    try {
        await pool.query(`
            INSERT INTO licenses (license_key, owner, email, expires_at, max_servers)
            VALUES ($1, $2, $3, $4, $5)
        `, [license_key, owner, email, expires_at || null, max_servers || 1]);

        await logAction(license_key, 'LICENSE_CREATED', `Owner: ${owner}`);

        res.json({ success: true, message: 'Licencja utworzona' });
    } catch (error) {
        console.error('Błąd tworzenia licencji:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// Wyłączenie licencji
app.post('/api/admin/license/disable', async (req, res) => {
    const { license_key, reason } = req.body;
    const adminKey = req.headers['x-admin-key'];

    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Brak autoryzacji' });
    }

    try {
        await pool.query(
            'UPDATE licenses SET status = $1, reason = $2 WHERE license_key = $3',
            ['DISABLED', reason || 'Wyłączona przez admina', license_key]
        );

        await logAction(license_key, 'LICENSE_DISABLED', reason || 'Admin action');

        res.json({ success: true, message: 'Licencja wyłączona' });
    } catch (error) {
        console.error('Błąd wyłączania licencji:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// Lista licencji
app.get('/api/admin/licenses', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];

    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Brak autoryzacji' });
    }

    try {
        const result = await pool.query(`
            SELECT 
                l.*,
                COUNT(DISTINCT ls.server_id) as active_servers
            FROM licenses l
            LEFT JOIN license_servers ls ON l.license_key = ls.license_key 
                AND ls.last_seen > NOW() - INTERVAL '1 hour'
            GROUP BY l.id
            ORDER BY l.created_at DESC
        `);

        res.json({ licenses: result.rows });
    } catch (error) {
        console.error('Błąd pobierania licencji:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// Start serwera
initDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
