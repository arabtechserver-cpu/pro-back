import sqlite3
conn=sqlite3.connect('dev.db')
c=conn.cursor()
c.execute("SELECT email, username, role FROM User WHERE role='admin'")
print(c.fetchall())
