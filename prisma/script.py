import sqlite3
conn = sqlite3.connect('dev.db')
c = conn.cursor()
c.execute("SELECT dhruId, requiresCustom FROM DhruService WHERE id = '08a37d70-7fc9-4430-82a8-be4c3391b267'")
row = c.fetchone()
if row:
    print('dhruId:', row[0])
    print('requiresCustom:', row[1])
else:
    print('Not found')
