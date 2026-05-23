// ============================================
// SCRIPT 3: Workload Questionnaire
// Compatible with MongoDB 4.4 - 8.0
// ============================================
print("\n========================================");
print("Workload Requirements Questionnaire");
print("========================================\n");
var workloadInfo = {
    mongoVersion: db.version(),

    // Fill these out based on your requirements
    questions: {
        q1_workloadType: "Is your workload CONSISTENT (24/7 steady load) or INTERMITTENT (periodic spikes)?",
        q2_latencyRequirement: "Do you require read latency < 50ms? (Yes/No)",
        q3_bulkOperations: "Do you use bulk write operations? (Yes/No)",
        q4_highAvailability: "Do you need multi-region deployment for HA? (Yes/No)",
        q5_geoSharding: "How many geographic regions need data? (1, 2, 3+)",
        q6_projectedGrowth: "What is your projected data size in 12 months? (GB)"
    },

    // Example answers (replace with your actual values)
    answers: {
        workloadType: "consistent",  // or "intermittent"
        readLatencyUnder50ms: false,  // true if you need <50ms
        bulkOpsPermitted: true,       // true if bulk ops are used
        multiRegionHA: false,         // true if multi-region needed
        geoShardedRegions: 1,         // number of regions
        projectedDataSizeGB: 500      // your 12-month projection
    }
};
printjson(workloadInfo);
