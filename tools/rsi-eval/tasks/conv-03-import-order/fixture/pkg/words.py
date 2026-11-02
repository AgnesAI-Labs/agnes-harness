from pkg import fmt

import re


def tidy(text):
    return re.sub(r"\s+", " ", fmt.title(text)).strip()
