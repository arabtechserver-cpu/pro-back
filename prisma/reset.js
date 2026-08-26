const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./dev.db');

bcrypt.hash('admin123', 10, function(err, hash) {
  db.run("UPDATE User SET password = ? WHERE email = 'admin@admin.com'", [hash], function(err) {
    if (err) {
      return console.log(err.message);
    }
    console.log(`Row(s) updated: ${this.changes}`);
    db.close();
  });
});
