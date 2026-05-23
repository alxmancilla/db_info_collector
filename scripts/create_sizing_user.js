// Create a read-only user with the minimum privileges required to run
// the sizing data collection scripts. Run this connected to the `admin`
// database as a user with userAdmin privileges. Replace the password
// before executing.
//
// Roles granted:
//   - clusterMonitor       : serverStatus, hostInfo, listDatabases
//   - readAnyDatabase      : getCollectionNames, collStats, $indexStats
//                            on every user database
db.createUser({
  user: "sizingUser",
  pwd: "password",
  roles: [
    { role: "clusterMonitor",  db: "admin" },
    { role: "readAnyDatabase", db: "admin" }
  ]
})
