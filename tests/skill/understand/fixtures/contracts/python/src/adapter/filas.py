import pika
import redis
from kafka import KafkaConsumer, KafkaProducer

producer = KafkaProducer()
producer.send("pedidos-criados", value=b"{}")
consumidor = KafkaConsumer("pedidos-criados", group_id="loja")

canal = pika.BlockingConnection().channel()
canal.basic_publish(exchange="", routing_key="fila-cargas", body="{}")
canal.basic_consume(queue="fila-cargas", on_message_callback=print)

r = redis.Redis()
r.publish("canal-precos", "1")
p = r.pubsub()
p.subscribe("canal-precos")
