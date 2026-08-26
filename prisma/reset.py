import sqlite3
import bcrypt

conn = sqlite3.connect('dev.db')
c = conn.cursor()

# Set password to "admin123"
hashed = bcrypt.hashpw(b"admin123", bcrypt.gensalt())
c.execute("UPDATE User SET password=? WHERE email='admin@admin.com'", (hashed,))
conn.commit()
print("Password reset successfully")
