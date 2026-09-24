# Subset SQL

Soportado (fase 1 parser TS mínimo, compilado a QueryBuilder):

```sql
CREATE TABLE users (id STRING PRIMARY KEY, age UINT32, balance FLOAT64);
INSERT INTO users (id, age) VALUES ('u1', 28);
SELECT id, age FROM users WHERE age >= 18 ORDER BY age DESC LIMIT 10;
SELECT COUNT(*) FROM users WHERE age < 30;
UPDATE users SET balance = 99.5 WHERE id = 'u1';
DELETE FROM users WHERE id = 'u1';
SELECT * FROM orders JOIN users ON orders.user_id = users.id WHERE age > 20;
```

No soportado: subqueries, triggers, procedures, DDL alter complejo,
tipos exóticos. El parser rechaza explícitamente con mensaje útil.
