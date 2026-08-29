"""Healf's catalogue, read from the storefront the runner would buy from anyway.

Healf publishes a Shopify sitemap of every product with its title and image, and each
product page carries schema.org JSON-LD with brand, price and description. That is
enough to recommend real, in-stock products without an API key or a scraped mirror,
and it stays correct when Healf changes its range.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from html import unescape
from time import monotonic

import httpx
from pydantic import BaseModel

SITEMAP = "https://healf.com/sitemap-products.xml"
CATALOGUE_TTL = 6 * 60 * 60
DETAIL_TTL = 24 * 60 * 60
ENDURANCE_NEEDS = (
    "electrolyte",
    "magnesium",
    "protein",
    "energy gel",
    "creatine",
    "iron",
    "collagen",
    "sleep",
)
STOPWORDS = frozenset(
    "a an and the for with to of my me i im need want some more help best good you your"
    " runner running run take taking buy recommend recommendation product products"
    " on in at it is that this after before during long short daily every when".split()
)

log = logging.getLogger(__name__)

_URL = re.compile(r"<loc>(https://healf\.com/products/[^<]+)</loc>")
_TITLE = re.compile(r"<image:title>([^<]*)</image:title>")
_IMAGE = re.compile(r"<image:loc>([^<]*)</image:loc>")
_LD_JSON = re.compile(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', re.S)


class Product(BaseModel):
    handle: str
    title: str
    url: str
    image: str = ""
    brand: str = ""
    price: str = ""
    currency: str = "GBP"
    description: str = ""


class HealfError(RuntimeError):
    pass


class Catalogue:
    """The product index, kept in memory because it changes daily at most."""

    def __init__(self) -> None:
        self._items: list[Product] = []
        self._loaded_at = 0.0
        self._details: dict[str, tuple[float, Product]] = {}
        self._lock = asyncio.Lock()

    async def all(self) -> list[Product]:
        async with self._lock:
            if self._items and monotonic() - self._loaded_at < CATALOGUE_TTL:
                return self._items
            self._items = await self._load()
            self._loaded_at = monotonic()
            return self._items

    async def search(self, need: str, limit: int = 6) -> list[Product]:
        """Rank the catalogue against what the coach thinks the runner needs."""
        items = await self.all()
        words = [word for word in _words(need) if word not in STOPWORDS]
        if not words:
            return []

        wanted = {_stem(word) for word in words}
        scored = []
        for item in items:
            title = _stem_words(item.title)
            hits = len(wanted & title)
            if not hits:
                continue
            # A product whose title is mostly the asked-for thing beats one that merely
            # mentions it, so "magnesium" does not return every multivitamin.
            scored.append((hits, -len(title), item))

        scored.sort(key=lambda row: (row[0], row[1]), reverse=True)
        top = [item for _, _, item in scored[:limit]]
        return await asyncio.gather(*(self.detail(item) for item in top)) if top else []

    async def featured(self, per_need: int = 2) -> list[Product]:
        """What the tab shows before the coach has recommended anything."""
        found: dict[str, Product] = {}
        for need in ENDURANCE_NEEDS:
            for product in await self.search(need, limit=per_need):
                found.setdefault(product.handle, product)
        return list(found.values())

    async def detail(self, item: Product) -> Product:
        """Fill in brand, price and description from the product page's JSON-LD."""
        cached = self._details.get(item.handle)
        if cached and monotonic() - cached[0] < DETAIL_TTL:
            return cached[1]

        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                response = await client.get(item.url)
                response.raise_for_status()
            full = _from_page(item, response.text)
        except Exception:
            log.warning("no product detail for %s", item.handle)
            return item

        self._details[item.handle] = (monotonic(), full)
        return full

    async def _load(self) -> list[Product]:
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                response = await client.get(SITEMAP)
                response.raise_for_status()
        except Exception as error:
            raise HealfError(f"could not read the Healf catalogue: {error}") from error

        items = [_from_sitemap(entry) for entry in response.text.split("</url>")]
        found = [item for item in items if item]
        if not found:
            raise HealfError("the Healf catalogue came back empty")
        log.info("loaded %d Healf products", len(found))
        return found


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _stem(word: str) -> str:
    """Enough to make "electrolytes" find "Electrolyte". Not a linguistics project."""
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _stem_words(text: str) -> set[str]:
    # Whole words only: matching substrings makes "long runs" recommend "Longevity".
    return {_stem(word) for word in _words(text)}


def _from_sitemap(entry: str) -> Product | None:
    url = _URL.search(entry)
    if not url:
        return None
    title = _TITLE.search(entry)
    image = _IMAGE.search(entry)
    handle = url.group(1).rsplit("/", 1)[-1]
    return Product(
        handle=handle,
        title=unescape(title.group(1)) if title else handle.replace("-", " ").title(),
        url=url.group(1),
        image=image.group(1) if image else "",
    )


def _from_page(item: Product, html: str) -> Product:
    for block in _LD_JSON.findall(html):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        if data.get("@type") != "Product":
            continue
        offer = data.get("offers") or {}
        if isinstance(offer, list):
            offer = offer[0] if offer else {}
        brand = data.get("brand") or {}
        return item.model_copy(
            update={
                "title": data.get("name") or item.title,
                "image": data.get("image") or item.image,
                "brand": brand.get("name", "") if isinstance(brand, dict) else str(brand),
                "price": str(offer.get("price", "")),
                "currency": offer.get("priceCurrency", "GBP"),
                "description": " ".join((data.get("description") or "").split())[:400],
            }
        )
    return item


def spoken_summary(products: list[Product]) -> str:
    """What the coach reads out: two products at most, because this is a phone call."""
    if not products:
        return "Nothing in the Healf range matches that. Describe the need differently."
    lines = []
    for product in products[:2]:
        price = f" at {product.price} {product.currency}" if product.price else ""
        brand = f" by {product.brand}" if product.brand else ""
        lines.append(f"{product.title}{brand}{price}. {product.description}"[:320])
    lines.append("They are on the runner's screen now.")
    return " ".join(lines)


catalogue = Catalogue()
