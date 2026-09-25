# API reference (relacional)

- `RelationalDatabase.createTable/dropTable/table/listTables`
- `RelationalTable.insert/findByPk/scan/update/delete/count`
- `QueryBuilder.where/select/orderBy/limit/offset/all/count/agg`
- `hashJoin(left,right,leftKey,rightKey)`
- `aggregate(rows,fn,col)`, `matchesWhere`, `parseSelect/executeSelect`
- `Transaction.insert/update/delete/commit/rollback`
- `assertUnique/assertForeignKey/bootCatalog/lookupByColumn`
- `ArtMirror.mirrorPk/lookupPk/unmirrorPk/syncTable/scanTable/scanRange`
- `NativeSecondaryIndex.add/lookup/lookupRange/remove` (`unique?`)
- `saveCatalog/loadCatalogDefs/restoreCatalog/snapshotCatalog` (DDL durable)
- SQL: `classifyStatement/parseSelect/parseInsert/parseUpdate/parseDelete/parseCreateTable/parseJoin/parseLiteral/isCountStar`, `executeSelect/executeJoin/executeQuery/executeSql`
