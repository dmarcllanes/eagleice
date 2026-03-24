from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto('http://127.0.0.1:7860')
    page.wait_for_selector('#map canvas')
    result = page.evaluate('typeof world.globeTileEngineUrl')
    result2 = page.evaluate('typeof world.tilesData')
    print("globeTileEngineUrl type:", result)
    print("tilesData type:", result2)
    browser.close()
