const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();
const cron = require('node-cron');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query('SELECT PostGIS_Version();', (err, res) => {
    if (err) {
        console.error('Veritabanı bağlantı hatası:', err.message);
    } else {
        console.log('Bulut Veritabanına (Neon) Başarıyla Bağlanıldı!');
        console.log('Aktif PostGIS Sürümü:', res.rows[0].postgis_version);
    }
});

app.get('/', (req, res) => {
    res.json({ 
        durum: 'Aktif',
        mesaj: 'Akıllı Park Destek Sistemi API Çalışıyor!',
        uc_noktalar: [
            '/api/otoparklar/ispark',
            '/api/park/yakindakiler?lat=41.0082&lng=28.9784&mesafe=10000',
            '/api/auth/kayit',
            '/api/auth/giris',
            '/api/park/ekle',
            '/api/park/oyla'
        ]
    });
});

app.post('/api/auth/kayit', async (req, res) => {
    try {
        const { ad_soyad, email, sifre } = req.body;
        const sifre_hash = await bcrypt.hash(sifre, 10);

        const sonuc = await pool.query(
            `INSERT INTO kullanicilar (ad_soyad, email, sifre_hash) 
             VALUES ($1, $2, $3) RETURNING id, ad_soyad, email, toplam_puan, guvenilirlik_derecesi, rozet`,
            [ad_soyad, email, sifre_hash]
        );

        res.status(201).json({ mesaj: 'Kayıt başarılı!', kullanici: sonuc.rows[0] });
    } catch (err) {
        res.status(400).json({ hata: 'Kayıt başarısız (E-posta kullanımda olabilir).', detay: err.message });
    }
});

app.post('/api/auth/giris', async (req, res) => {
    try {
        const { email, sifre } = req.body;
        const sonuc = await pool.query('SELECT * FROM kullanicilar WHERE email = \$1', [email]);

        if (sonuc.rows.length === 0) return res.status(404).json({ hata: 'Kullanıcı bulunamadı.' });

        const kullanici = sonuc.rows[0];
        const sifreDogruMu = await bcrypt.compare(sifre, kullanici.sifre_hash);

        if (!sifreDogruMu) return res.status(401).json({ hata: 'Hatalı şifre!' });

        const token = jwt.sign({ id: kullanici.id, email: kullanici.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.json({
            mesaj: 'Giriş başarılı!',
            token,
            kullanici: {
                id: kullanici.id,
                ad_soyad: kullanici.ad_soyad,
                email: kullanici.email,
                toplam_puan: kullanici.toplam_puan,
                guvenilirlik_derecesi: kullanici.guvenilirlik_derecesi,
                rozet: kullanici.rozet
            }
        });
    } catch (err) {
        res.status(500).json({ hata: err.message });
    }
});

app.get('/api/park/yakindakiler', async (req, res) => {
    try {
        const { lat, lng, mesafe = 5000 } = req.query;
        if (!lat || !lng) return res.status(400).json({ hata: 'Lütfen lat ve lng gönderin.' });

        const sorgu = `
            SELECT id, bildiren_kullanici_id, fotograf_url, enlem, boylam, 
                   allowed_vehicles, guncel_guven_skoru, durum, ai_onayli_mi, olusturulma_tarihi,
                   ROUND(ST_Distance(konum, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)) AS mesafe_metre
            FROM park_noktalari
            WHERE durum = 'bos'
              AND ST_DWithin(konum, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
            ORDER BY mesafe_metre ASC;
        `;

        const sonuc = await pool.query(sorgu, [parseFloat(lng), parseFloat(lat), parseInt(mesafe)]);
        res.json(sonuc.rows);
    } catch (err) {
        res.status(500).json({ hata: err.message });
    }
});

app.post('/api/park/ekle', async (req, res) => {
    try {
        const { kullanici_id, enlem, boylam, fotograf_url, allowed_vehicles, ai_onayli_mi } = req.body;
        const sorgu = `
            INSERT INTO park_noktalari (bildiren_kullanici_id, fotograf_url, konum, enlem, boylam, allowed_vehicles, ai_onayli_mi, durum)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $4, $3, $5, $6, 'bos')
            RETURNING *;
        `;
        const sonuc = await pool.query(sorgu, [
            kullanici_id || null,
            fotograf_url || 'https://ornek.com/default_park.jpg',
            parseFloat(boylam),
            parseFloat(enlem),
            allowed_vehicles || ['car'],
            ai_onayli_mi || false
        ]);
        res.status(201).json({ mesaj: 'Park noktası eklendi!', park_noktasi: sonuc.rows[0] });
    } catch (err) {
        res.status(500).json({ hata: err.message });
    }
});

app.post('/api/park/oyla', async (req, res) => {
    try {
        const { park_id, oy_veren_kullanici_id, oy_tipi } = req.body; // 'hala_bos' veya 'artik_dolu'

        await pool.query(
            `INSERT INTO dogrulama_oylari (park_id, oy_veren_kullanici_id, oy_tipi) VALUES ($1, $2, $3)`,
            [park_id, oy_veren_kullanici_id, oy_tipi]
        );

        if (oy_tipi === 'artik_dolu') {
            await pool.query(`UPDATE park_noktalari SET durum = 'dolu', guncellenme_tarihi = CURRENT_TIMESTAMP WHERE id = $1`, [park_id]);
        } else if (oy_tipi === 'hala_bos') {
            await pool.query(`UPDATE park_noktalari SET guncel_guven_skoru = LEAST(100, guncel_guven_skoru + 5), guncellenme_tarihi = CURRENT_TIMESTAMP WHERE id = $1`, [park_id]);
        }

        res.json({ mesaj: 'Oyunuz kaydedildi ve park durumu güncellendi!' });
    } catch (err) {
        res.status(400).json({ hata: 'Oy kaydedilemedi.', detay: err.message });
    }
});

app.get('/api/otoparklar/ispark', async (req, res) => {
    try {
        const response = await axios.get('https://api.ibb.gov.tr/ispark/Park');
        const otoparklar = response.data.slice(0, 30).map(park => ({
            ispark_id: park.parkID,
            otopark_adi: park.parkName,
            enlem: parseFloat(park.lat),
            boylam: parseFloat(park.lng),
            kapasite: park.capacity,
            bos_kapasite: park.emptyCapacity,
            ilce: park.district
        }));
        res.json(otoparklar);
    } catch (err) {
        res.status(500).json({ hata: 'İSPARK verileri alınamadı.', detay: err.message });
    }
});


cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET 
});

const upload = multer({ dest: 'uploads/' }); 


app.post('/api/fotograf-yukle', upload.single('fotograf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ hata: 'Lütfen bir fotoğraf seçin.' });
        }

        
        const sonuc = await cloudinary.uploader.upload(req.file.path, {
            folder: 'akilli_park_fotograflar' 
        });

        
        fs.unlinkSync(req.file.path);

        
        res.json({ 
            mesaj: 'Fotoğraf başarıyla buluta yüklendi!',
            fotograf_url: sonuc.secure_url 
        });

    } catch (hata) {
        console.error('Fotoğraf yükleme hatası:', hata);
        res.status(500).json({ hata: 'Yükleme başarısız oldu.', detay: hata.message });
    }
});


app.get('/api/liderlik-tablosu', async (req, res) => {
    try {
        
        const query = `
            SELECT id, ad_soyad, toplam_puan 
            FROM kullanicilar 
            ORDER BY toplam_puan DESC NULLS LAST, id ASC 
            LIMIT 10;
        `;
        
        
        const { rows } = await pool.query(query); 
        
        res.json(rows); 
    } catch (hata) {
        console.error('Liderlik tablosu hatası:', hata);
        res.status(500).json({ hata: 'Liderlik tablosu alınamadı.' });
    }
});


app.post('/api/puan-ekle', async (req, res) => {
    try {
        const { kullanici_id, kazanilan_puan } = req.body;

        if (!kullanici_id || !kazanilan_puan) {
            return res.status(400).json({ hata: 'Kullanıcı ID ve kazanılan puan gereklidir.' });
        }

        
        const query = `
            UPDATE kullanicilar 
            SET toplam_puan = toplam_puan + $1 
            WHERE id = $2 
            RETURNING id, ad_soyad, toplam_puan;
        `;
        
        
        const { rows } = await pool.query(query, [kazanilan_puan, kullanici_id]);

        if (rows.length === 0) {
            return res.status(404).json({ hata: 'Kullanıcı bulunamadı.' });
        }

        res.json({ 
            mesaj: 'Puan başarıyla eklendi! 🎉', 
            kullanici: rows[0] 
        });
    } catch (hata) {
        console.error('Puan ekleme hatası:', hata);
        res.status(500).json({ hata: 'Puan eklenirken bir sorun oluştu.' });
    }
});

cron.schedule('0 * * * *', async () => {
    console.log('⏳ İSPARK verileri çekiliyor ve veritabanı güncelleniyor...');
    try {
        
        const response = await axios.get('https://api.ibb.gov.tr/ispark/Park'); 
        const otoparklar = response.data;

        for (const park of otoparklar) {
            
            const query = `
                INSERT INTO otoparklar (ispark_id, otopark_adi, ilce, kapasite, bos_kapasite, konum)
                VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326))
                ON CONFLICT (ispark_id) 
                DO UPDATE SET bos_kapasite = EXCLUDED.bos_kapasite;
            `;
           
            const values = [
                park.parkID, 
                park.parkName, 
                park.ilce, 
                park.capacity, 
                park.emptyCapacity, 
                park.lng, // Boylam
                park.lat  // Enlem
            ];
            
            await pool.query(query, values); 
        }
        console.log('✅ İSPARK verileri veritabanına başarıyla kaydedildi/güncellendi!');
    } catch (error) {
        console.error('❌ İSPARK verileri güncellenirken hata:', error.message);
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor...`);
});