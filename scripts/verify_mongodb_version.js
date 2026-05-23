// Verify MongoDB 8.0
var buildInfo = db.serverStatus();
print("MongoDB Version: " + buildInfo.version);
print("Storage Engine: " + buildInfo.storageEngine.name);
// Check for MongoDB 8.0 specific features
if (buildInfo.version.startsWith("8.")) {
    print("✓ MongoDB 8.0 detected - all sizing scripts fully compatible");
}
