# FAQ relacional

**¿Reemplaza a Postgres?** No. Es single-node, subset SQL, zero-copy.
**¿Rompe KV existente?** No. KV sigue; relacional usa namespaces nuevos.
**¿Necesita daemon nuevo?** No. Mismo daemon, mismo WAL/snapshot.
**¿Cluster?** No-objetivo. Single-node durabilidad primero.
