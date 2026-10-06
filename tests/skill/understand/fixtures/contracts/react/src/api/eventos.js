import { Kafka } from 'kafkajs'
import amqp from 'amqplib'

const kafka = new Kafka({ brokers: ['kafka:9092'] })

export async function publicar(producer, consumer, channel) {
  await producer.send({ topic: 'eventos-pedido', messages: [{ value: '{}' }] })
  await consumer.subscribe({ topic: 'eventos-pedido', fromBeginning: true })
  channel.sendToQueue('fila-relatorios', Buffer.from('{}'))
  channel.consume('fila-relatorios', () => {})
}
