import { messageBrokerENV } from '@ruguin/env'
import { type MessageBrokerModuleOptions } from '@ruguin/message-broker'

export function createMessageBrokerModuleOptions(): MessageBrokerModuleOptions {
  return {
    brokers: messageBrokerENV.KAFKA_BOOTSTRAP_BROKERS.split(','),
    clientId: messageBrokerENV.KAFKA_CLIENT_ID,
    ssl: messageBrokerENV.KAFKA_SSL,
    /*
     * messageBrokerENV.KAFKA_AUTO_CREATE_TOPICS defaults to false (a safe default for a production
     * broker with deliberate topic provisioning) and nothing in this plan provisions topics ahead of
     * time — reading that env var here would reintroduce the exact "hangs forever against a fresh
     * broker" bug Task 7 found and fixed. Hardcoded true at this app-wiring layer instead, so a
     * future environment that DOES provision topics ahead of time can flip it per-app without
     * touching the shared packages/message-broker package.
     */
    autoCreateTopics: true
  }
}
