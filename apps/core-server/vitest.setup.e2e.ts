process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'
process.env.ENVIRONMENT ??= 'test'
/*
 * app.module.ts now wires MessageBrokerModule (publishing side of the outbox→dispatch-worker
 * flow) — matches apps/dispatch-worker's own docker-compose Kafka listener.
 */
process.env.KAFKA_BOOTSTRAP_BROKERS ??= 'localhost:9092'
