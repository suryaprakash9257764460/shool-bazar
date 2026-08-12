require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new sqlite3.Database('./db/database.sqlite', (err) => {
  if (err) console.error(err);
  else console.log('Connected to SQLite database.');
});

// Create tables (if not exists)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    icon TEXT,
    status INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    product_url TEXT NOT NULL,
    merchant TEXT,
    image TEXT,
    images TEXT,
    price REAL,
    mrp REAL,
    discount REAL,
    brand TEXT,
    weight TEXT,
    size TEXT,
    variant TEXT,
    short_description TEXT,
    description TEXT,
    features TEXT,
    specifications TEXT,
    category_id INTEGER,
    tags TEXT,
    featured INTEGER DEFAULT 0,
    homepage_visible INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    click_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS click_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    event_type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    campaign TEXT,
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);

  // Insert default admin if not exists (password: 2580)
  const defaultPass = bcrypt.hashSync('2580', 10);
  db.run(`INSERT OR IGNORE INTO admin_users (username, password_hash) VALUES (?, ?)`, ['admin', defaultPass]);
});

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  else res.redirect('/admin/login');
}

// ==================== PUBLIC ROUTES ====================

// Helper to get categories
function getCategories(callback) {
  db.all('SELECT * FROM categories WHERE status = 1 ORDER BY sort_order, name', callback);
}

// Homepage
app.get('/', (req, res) => {
  getCategories((err, categories) => {
    if (err) categories = [];
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;
    db.all('SELECT * FROM products WHERE status = "active" ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset], (err, products) => {
      db.get('SELECT COUNT(*) as total FROM products WHERE status = "active"', (err, count) => {
        const total = count ? count.total : 0;
        const totalPages = Math.ceil(total / limit);
        // Featured products
        db.all('SELECT * FROM products WHERE featured = 1 AND status = "active" LIMIT 8', (err, featured) => {
          res.render('index', {
            categories,
            products,
            featured: featured || [],
            currentPage: page,
            totalPages,
            totalProducts: total,
            searchQuery: '',
            currentCategory: null
          });
        });
      });
    });
  });
});

// Category page
app.get('/category/:slug', (req, res) => {
  const slug = req.params.slug;
  getCategories((err, categories) => {
    db.get('SELECT * FROM categories WHERE slug = ? AND status = 1', [slug], (err, category) => {
      if (!category) return res.redirect('/');
      const page = parseInt(req.query.page) || 1;
      const limit = 12;
      const offset = (page - 1) * limit;
      db.all('SELECT * FROM products WHERE category_id = ? AND status = "active" ORDER BY created_at DESC LIMIT ? OFFSET ?', [category.id, limit, offset], (err, products) => {
        db.get('SELECT COUNT(*) as total FROM products WHERE category_id = ? AND status = "active"', [category.id], (err, count) => {
          const total = count ? count.total : 0;
          const totalPages = Math.ceil(total / limit);
          res.render('category', {
            categories,
            category,
            products,
            currentPage: page,
            totalPages,
            totalProducts: total,
            searchQuery: '',
            currentCategory: category
          });
        });
      });
    });
  });
});

// Search
app.get('/search', (req, res) => {
  const q = req.query.q || '';
  getCategories((err, categories) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;
    const searchTerm = `%${q}%`;
    db.all(`SELECT * FROM products WHERE status = "active" AND (
      name LIKE ? OR brand LIKE ? OR tags LIKE ? OR short_description LIKE ? OR description LIKE ?
    ) LIMIT ? OFFSET ?`, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, limit, offset], (err, products) => {
      db.get(`SELECT COUNT(*) as total FROM products WHERE status = "active" AND (
        name LIKE ? OR brand LIKE ? OR tags LIKE ? OR short_description LIKE ? OR description LIKE ?
      )`, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm], (err, count) => {
        const total = count ? count.total : 0;
        const totalPages = Math.ceil(total / limit);
        res.render('search', {
          categories,
          products,
          currentPage: page,
          totalPages,
          totalProducts: total,
          searchQuery: q,
          currentCategory: null
        });
      });
    });
  });
});

// Product detail
app.get('/product/:slug', (req, res) => {
  const slug = req.params.slug;
  getCategories((err, categories) => {
    db.get(`SELECT p.*, c.name as category_name FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.slug = ? AND p.status = "active"`, [slug], (err, product) => {
      if (!product) return res.redirect('/');
      // Increment click count (optional)
      res.render('product', { categories, product });
    });
  });
});

// Outbound click tracking and redirect
app.get('/go/:slug', (req, res) => {
  const slug = req.params.slug;
  db.get('SELECT * FROM products WHERE slug = ?', [slug], (err, product) => {
    if (!product) return res.redirect('/');
    // Increment click count
    db.run('UPDATE products SET click_count = click_count + 1 WHERE id = ?', [product.id]);
    // Log click event
    db.run('INSERT INTO click_events (product_id, event_type, source) VALUES (?, ?, ?)', [product.id, 'outbound', req.query.source || 'direct']);
    // Redirect to merchant URL
    res.redirect(product.product_url);
  });
});

// API endpoints for client-side search (used in public page)
app.get('/api/search', (req, res) => {
  const q = req.query.q || '';
  const searchTerm = `%${q}%`;
  db.all(`SELECT id, name, slug, image, price, brand, category_id, 
    (SELECT name FROM categories WHERE id = products.category_id) as category_name
    FROM products WHERE status = "active" AND (
      name LIKE ? OR brand LIKE ? OR tags LIKE ? OR short_description LIKE ? OR description LIKE ?
    ) LIMIT 10`, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm], (err, products) => {
    res.json({ products: products || [] });
  });
});

app.get('/api/categories', (req, res) => {
  db.all('SELECT * FROM categories WHERE status = 1 ORDER BY sort_order, name', (err, categories) => {
    res.json({ categories: categories || [] });
  });
});

app.get('/api/products/featured', (req, res) => {
  db.all('SELECT * FROM products WHERE featured = 1 AND status = "active" LIMIT 8', (err, products) => {
    res.json({ products: products || [] });
  });
});

app.get('/api/products', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 12;
  const offset = (page - 1) * limit;
  const sort = req.query.sort || 'newest';
  let orderBy = 'created_at DESC';
  if (sort === 'price_low') orderBy = 'price ASC';
  else if (sort === 'price_high') orderBy = 'price DESC';
  else if (sort === 'discount') orderBy = 'discount DESC';
  else if (sort === 'popular') orderBy = 'click_count DESC';

  let whereClause = "status = 'active'";
  const params = [];
  if (req.query.category) {
    whereClause += " AND category_id = (SELECT id FROM categories WHERE slug = ?)";
    params.push(req.query.category);
  }
  if (req.query.search) {
    const searchTerm = `%${req.query.search}%`;
    whereClause += ` AND (name LIKE ? OR brand LIKE ? OR tags LIKE ? OR short_description LIKE ? OR description LIKE ?)`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const sql = `SELECT * FROM products WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) as total FROM products WHERE ${whereClause}`;

  db.all(sql, [...params, limit, offset], (err, products) => {
    db.get(countSql, params, (err, count) => {
      const total = count ? count.total : 0;
      res.json({
        products: products || [],
        total,
        page,
        totalPages: Math.ceil(total / limit)
      });
    });
  });
});

// ==================== ADMIN ROUTES ====================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  db.get('SELECT * FROM admin_users WHERE username = "admin"', (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('admin/login', { error: 'Invalid password' });
    }
    req.session.user = { id: user.id, username: user.username };
    res.redirect('/admin/dashboard');
  });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', isAuthenticated, (req, res) => {
  db.get('SELECT COUNT(*) as total FROM products', (err, total) => {
    db.get('SELECT COUNT(*) as active FROM products WHERE status = "active"', (err, active) => {
      db.get('SELECT COUNT(*) as inactive FROM products WHERE status = "inactive"', (err, inactive) => {
        db.get('SELECT COUNT(*) as categories FROM categories', (err, catCount) => {
          db.get('SELECT COUNT(*) as uncategorized FROM products WHERE category_id IS NULL AND status = "active"', (err, uncat) => {
            db.all('SELECT * FROM products ORDER BY created_at DESC LIMIT 5', (err, recent) => {
              db.all('SELECT * FROM products ORDER BY click_count DESC LIMIT 5', (err, popular) => {
                db.get('SELECT SUM(click_count) as totalClicks FROM products', (err, clicks) => {
                  res.render('admin/dashboard', {
                    totalProducts: total ? total.total : 0,
                    activeProducts: active ? active.active : 0,
                    inactiveProducts: inactive ? inactive.inactive : 0,
                    totalCategories: catCount ? catCount.categories : 0,
                    uncategorized: uncat ? uncat.uncategorized : 0,
                    recent: recent || [],
                    popular: popular || [],
                    totalClicks: clicks ? clicks.totalClicks : 0
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// Products list
app.get('/admin/products', isAuthenticated, (req, res) => {
  db.all('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.created_at DESC', (err, products) => {
    db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
      res.render('admin/products', { products: products || [], categories: categories || [] });
    });
  });
});

// Add product form
app.get('/admin/products/add', isAuthenticated, (req, res) => {
  db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
    res.render('admin/add-product', { categories: categories || [], product: null, error: null });
  });
});

// Handle add product (with auto-fetch from URL)
app.post('/admin/products/add', isAuthenticated, async (req, res) => {
  const { product_url, name, price, mrp, discount, brand, description, category_id, featured, homepage_visible, status } = req.body;
  // If only URL provided, try to fetch data (simplified)
  let productData = { product_url, name, price, mrp, discount, brand, description, category_id, featured, homepage_visible, status };
  if (product_url && !name) {
    // Attempt to fetch from URL (mock)
    try {
      // In real scenario, use merchant APIs; here we just simulate
      const mockData = {
        name: 'Sample Product from ' + product_url,
        price: 1999,
        mrp: 2999,
        discount: 33,
        brand: 'Generic',
        description: 'Auto-fetched description.'
      };
      Object.assign(productData, mockData);
    } catch (e) {}
  }
  // Generate slug
  const slug = productData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  db.run(`INSERT INTO products (name, slug, product_url, price, mrp, discount, brand, description, category_id, featured, homepage_visible, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [productData.name, slug, productData.product_url, productData.price, productData.mrp, productData.discount,
      productData.brand, productData.description, productData.category_id || null,
      productData.featured || 0, productData.homepage_visible || 1, productData.status || 'active'
    ],
    function(err) {
      if (err) {
        db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
          res.render('admin/add-product', { categories, product: productData, error: 'Error saving product: ' + err.message });
        });
      } else {
        res.redirect('/admin/products');
      }
    });
});

// Bulk add
app.get('/admin/products/bulk', isAuthenticated, (req, res) => {
  db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
    res.render('admin/bulk-add', { categories: categories || [], results: null });
  });
});

app.post('/admin/products/bulk', isAuthenticated, (req, res) => {
  const { urls, category_id, status, featured, homepage_visible } = req.body;
  const urlList = urls.split('\n').filter(u => u.trim());
  const results = [];
  let processed = 0;
  urlList.forEach((url, index) => {
    const slug = 'bulk-' + Date.now() + '-' + index;
    const name = 'Product from ' + url;
    db.run(`INSERT INTO products (name, slug, product_url, category_id, status, featured, homepage_visible)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, slug, url.trim(), category_id || null, status || 'active', featured || 0, homepage_visible || 1],
      function(err) {
        if (err) {
          results.push({ url, status: 'Failed', error: err.message });
        } else {
          results.push({ url, status: 'Imported', id: this.lastID });
        }
        processed++;
        if (processed === urlList.length) {
          db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
            res.render('admin/bulk-add', { categories: categories || [], results });
          });
        }
      });
  });
  if (urlList.length === 0) {
    db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
      res.render('admin/bulk-add', { categories: categories || [], results: [] });
    });
  }
});

// Edit product
app.get('/admin/products/edit/:id', isAuthenticated, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM products WHERE id = ?', [id], (err, product) => {
    db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
      res.render('admin/add-product', { categories: categories || [], product, error: null });
    });
  });
});

app.post('/admin/products/edit/:id', isAuthenticated, (req, res) => {
  const id = req.params.id;
  const { name, product_url, price, mrp, discount, brand, description, category_id, featured, homepage_visible, status } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + id;
  db.run(`UPDATE products SET name=?, slug=?, product_url=?, price=?, mrp=?, discount=?, brand=?, description=?, category_id=?, featured=?, homepage_visible=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`,
    [name, slug, product_url, price, mrp, discount, brand, description, category_id || null, featured || 0, homepage_visible || 1, status, id],
    function(err) {
      if (err) {
        db.all('SELECT * FROM categories ORDER BY name', (err, categories) => {
          db.get('SELECT * FROM products WHERE id = ?', [id], (err, product) => {
            res.render('admin/add-product', { categories, product, error: 'Error updating: ' + err.message });
          });
        });
      } else {
        res.redirect('/admin/products');
      }
    });
});

// Delete product
app.post('/admin/products/delete/:id', isAuthenticated, (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function(err) {
    res.redirect('/admin/products');
  });
});

// Toggle status
app.post('/admin/products/toggle/:id', isAuthenticated, (req, res) => {
  db.get('SELECT status FROM products WHERE id = ?', [req.params.id], (err, row) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active';
    db.run('UPDATE products SET status = ? WHERE id = ?', [newStatus, req.params.id], () => {
      res.redirect('/admin/products');
    });
  });
});

// Categories management
app.get('/admin/categories', isAuthenticated, (req, res) => {
  db.all('SELECT * FROM categories ORDER BY sort_order, name', (err, categories) => {
    res.render('admin/categories', { categories: categories || [] });
  });
});

app.post('/admin/categories/add', isAuthenticated, (req, res) => {
  const { name, slug, description, icon, sort_order, status } = req.body;
  db.run(`INSERT INTO categories (name, slug, description, icon, sort_order, status)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [name, slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description, icon, sort_order || 0, status || 1],
    function(err) {
      res.redirect('/admin/categories');
    });
});

app.post('/admin/categories/delete/:id', isAuthenticated, (req, res) => {
  db.run('DELETE FROM categories WHERE id = ?', [req.params.id], () => {
    res.redirect('/admin/categories');
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`Shool Bazar running on http://localhost:${PORT}`);
  console.log(`Admin login: http://localhost:${PORT}/admin/login`);
});