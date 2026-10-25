"""A Python agent whose read tool returns what JSON.parse would change: a 64-bit id, whole-number
floats and an exponent. It prints what the tool gave it, as it would pass it on to a model."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from shadowlap import tool


@tool(effect="read")
def get_order(order_id: int):
    return {"id": 1234567890123456789, "price": 20.0, "scores": [1.5, 1e-07, -0.0], "order": order_id}


result = get_order(9007199254740993)
print(json.dumps({"text": json.dumps(result), "types": [type(result["id"]).__name__, type(result["price"]).__name__]}))
