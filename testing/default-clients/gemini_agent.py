"""An agent that builds its client the default way, ``genai.Client()``: its key comes from
GEMINI_API_KEY or GOOGLE_API_KEY, its base URL from the environment too."""

from google import genai

from answer import answer


def ask(prompt):
    # Held while it asks: the client closes its connections once it is collected.
    client = genai.Client()
    return client.models.generate_content(model="gemini-2.5-flash", contents=prompt).text


answer(ask)
