/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/**
 * Displacement luma calibration + the bundled ramp clip it uses.
 *
 * The ramp is a 128x128, 10-bit Main10, full-range, LOSSLESS HEVC code ramp (Y = pixelIndex & 1023,
 * neutral chroma), metadata-free (VPS/SPS/PPS/IDR only). Regenerate as described in
 * docs/DISPLACEMENT-CALIBRATION.md; do not edit the base64 by hand.
 *
 * `resolveCalibration()` decodes the ramp once per session and measures how THIS device maps a
 * decoded frame's luma back to the integer code. That is a device/GPU property, independent of the
 * displacement codec, so it stays valid if the decoder later moves to VP9/AV1 (no bitstream/VUI
 * parsing is involved). It returns { scaleY, offsetY, maxCode, bitDepth, source } for the mesh
 * shader's inline `code = round(y * scaleY + offsetY)`.
 */
import { GpuReadback } from './GpuReadback.js';

export const RAMP_HEVC_B64 =
  'AAAAAUABDAH//wIgAAADAJAAAAMAAAMA/5WYCQAAAAFCAQECIAAAAwCQAAADAAADAP+gECAgTZZWaSTK5sCAAAADAIAAAAMAhAAAAAFEAcFxqRIAAAEoAa8FuA2QSSMDN///krmXVxkhkjQUYkqPpV7HiCzD5BqX4yJvkMzf75DN0oApIqqoAAADAA4PGbnVCxiqn/rI+8ADedvGckJ0BGKvMn2QmKvMnmd4AAa63VyA+iYGAAHjV1U2AAADAb9Y/+MAAAMCQNod1AAACBeKKSCTpJ0O///+he/XY/3PX8Sz5drrFrt9rw1rmCOsiO4CPDiOYf6yf7gf8OJAAEr9opkAAAMCh9aM+ESOrhKOa9tlH1h+mXr3e0h4KcaHPd4KcaGh/AALVjTjcdJFcADyRyECAAAJDanIoAAAYMhvYwAABIv1jPgALIABTPCVP8AACT1JVLwAAEd3LqWAAASlmNhAAFuABWIJVPwAADNCMqdYAAICCgvKAAAqyH85wAAAAwBtmhUHAAAKGEwKwAAA9h+fgAAAF3mEISAAAAMAfPwO/wAADLLhsBAAAVoceEwAACSdNE+l6rfdr///gaLybT9EnewuN0LpArp+Lq7rnUkkGkn8krykdZ+Qh+f5+vKUAIxeCPcAABkeZJOzQDLlwauW4INwBhgGZb5o4knqgytvknqgyRhwAdpM8LQAAAMAEHbdi3AAAfAXvX4AADr3k4wAAAcXKThRhq34L///09L7QT++ffkSPPHtjnt5HuOns902P03l0470z5/ZB/eZ/jvUADZ6//kAAAqvUP3fWlptMeeOgePZrohPI6Mk+RfM1HPoxfM1HDooANvYPyMAAAMACiKNXBAAAUwCqH4AACrxhH8AAAWCFSx4AAADAE4yDAIAAApBUVAAAAMBW2SidgAALfzoosAAAARTjk3AAACRLKcUgAATG7SCEAACg4KuXAAAAwBNZPGnwAAKS5KhUAABYIVLHgAALxwNh4AAAAbFHq3QAADnYbqdAAAe7Pk1QAAEJWhf2AAAAwCJOaVMcAAJI5OqEwAAnGQYBAAAFP2yb8AAAAMD6qz/vwAAQ1O9UPgABHdy6lgAAJmBuSWAAAAgm7CMYAAEWz9KvAAAlLMbCAAAE+jO3FAAAATMDcksAACkFRUAAAMAFjFZ9yAAAvwCKcgAAAMAsBxqn0AAC9m8qeYAAMqKBewAABs9f/yAAAAHjV1U2AAAgYMlTPAACJzbSjAAASd59tEAAAMAWMVn3IAAC/AIpyAAAZjsilYAADcfFQ4AAAMAEVh6iFAAAlGEQfYAAE9RMObAAAqn3n0gAAADAvRRLMwAAGVFAvYAAA2ev/5AAAHT5B3iAAADAJ1aN6OAABU7OlegAALdPjXYAABiYqQXgAAAIjXlQOAABI6F4UwAAJxkGAQAABT9sm/AAAAHZBMaKAAA/SyHZwAAIc9YE8AABIbU5FAAAAMBasacbgAAMLZCPAAABoeWxfAAAOD458sAAAMAUwCqH4AACzdw74AAAYHZk2IAADPBpl/AAAATMDcksAACkFRUAAADAFjFZ9yAAAvwCKcgAAAEnefbRAAAnVo3o4AAFTs6V6AAAt0+NdhAgB///S1zsi2KRNXhZd+zji/C9OdcOYAvOiAL/72G9gOAMK92SAMLAAPGjC+0AADKcyVeYxaXMIoDDYkNiQ2JDYjhbgW4FuBa0C0C0CzRYBFYeohQAAAG7iPzEAAA7SZ4WgAAH86WMiAABEGb/3R79f//+n+/aFL01HvedseTnunHZO8pOyD+flcd6bzP7IlceP7zlceQAAde8nGAAAGK5u082pEzjhawnySfJJ8knyRJHCRwkcJFr1r1r1qVQCHPWBPAAAANx8VDgAAB17ycYAAAP0sh2cAACHPWBPAAAAMDExUgvAAAacGWiQAADi5ScKAAAeXWbC4AAAMAyooF7AAAGz1//IAAA6fIO8QAAHz8Dv8AAAMANBOw6kAABv2F7QgAAO+2zK4AACAgoLygAAANf/wKUAABzsN1OgAAPgL3r8AACErQv7Dd+///9gV+7N3rvPiBrclHT+OZUeF0dyn9RG5l44Yf3LG5mf4ZG5mgAA1reWewAALP0kv6Q96LV0AK2sraytrK2so9+Pfj3497x7x7x7vMAD2w7SVAAAAaCdh1IAADfsL2hAAAd9tmVwAAEBBQXlHqF///6f79oUvTUe952x5Oe6cdk7yk7IP5+Vx3pvM/siVx4/vOVx5AAB17ycYAAAYrm7TzakTOOFrCfJJ8knySfJEkcJHCRwkWvWvWvWpVAIc9YE8AAAMAOip5McAAB8qgR0gAAQtGVzUAACOnFLAgAAANs0Kg4AAB1nRyNgAAPvkXT0AACG61XEgAAAMDp8g7xAAAfPwO/wAAEMjoFfAAAju5dSwAAAMA+VQI6QAAIWjK5qAABHTilgQAAJjdpBCAAABC0ZXNQAAI6cUsCAABMbtIIQAAKLM6tYAAAA4uUnCgAAHl1mwuAABBDlvTgAAItn6VeAAAAwPTXdVYAACDtuxbgAARi8Ee4AACWn1pHAAAAwEJWhf2AAAjfg9q4AAEvKvPNAAAoijVwQAAAwBHyTkwAAAJmBuSWAABSCoqAAADACxis+5AAAARlgJwMAACWn1pHAAAUB5LQQAACtslE7AAAATMDcksAACkFRUAAAMAFjFZ9yAAAvwCKcgAAAMBT9sm/AAALVjTjcAABhbIR4AAANDy2L4AAAMAXJ3mWoAADGsYduAAAare2KIAADldXteAAAAXJ3mWoAADGsYduAAAare2KIAADldXteAAAAZekYCwAADbNCoOAAAdZ0cjYAAD75F09AAAAwHB8c+WAAA8FrhwwAAIEmmAeAABE5tpRgAAAwB6vcU1gAAQdt2LcAACMXgj3AAAS0+tI4AAAB6vcU1gAAQdt2LcAACMXgj3AAAS0+tI4AAACHj2rZgAASG1ORQAACad9jFAAAUwCqH4AAADAlLMbCAAAE+jO3FAAAq8YR/AAAFyd5lqAAADAKQVFQAAAwAWMVn3IAAC/AIpyAAAZjsilYAAAA1qzqnMAADmGeqbwAAPTXdVYAACDtuxbgAAAwDsh1VGAAAP3h9UTgABDnrAngAAJDanIoAAABBDlvTgAAItn6VeAABKWY2EAAAJ9GduKAAABHdy6lgAAJmBuSWAABSCoqAAAAMCxis+5AAAAwEihNVCgAATXNFUFAABTAKofgAALN3DvgAAAwAT9xNUCgABWIJVPwAAFyd5lqAAAxrGHbgAAAMBYxWfcgAAL8AinIAABmOyKVgAANx8VDgAAAMAYmKkF4AADTgy0SAAAcXKThQAADy6zYXAAAAY/zYzAAADA1reWewAAHNe0sQAAA9sO0lQAAAG7iPzEAAA7SZ4WgAAH86WMiAABEGb/3QAAAMB6GbAggAAQYlro0AACMC/5sgAASv2imQAAAMAhutVxIAAEgbQ7qAAAmiXOOoAAFKun5UAAAMAIc9YE8AABIbU5FAAAJp32MUAABTAKofgAAAJSzGwgAABPoztxQAAKvGEfwAABcneZagAAAMCkFRUAAADAFjFZ9yAAAvwCKcgAAGY7IpWAAADALdPjXYAABiYqQXgAANODLRIAABxcpOFAAADACprv/1AAALaJ1UmAAAxCEzGgAAGkdgXQAAAAwLz3P/PAAAydIVSEAADZR+rPAAAdFTyY4AAADQTsOpAAAb9he0IAADvtsyuAAAgIKC8oAAADmvaWIAAAe2HaSoAAEItgLhAAAjVQoloAAADA6+LKm2AAD8mN/voAAQ3Wq4kAACQNod1AAADAEET1/vIAARZOipigABKMIg+wAAJ6iYc2AAABHTilgQAAJjdpBCAABRZnVrAAALDmuqQAAADAToQWjIAACpNb2oAAAWwOxpgAADEITMaAAADAFDCYFYAAArlZmUAAAMBeOBsPAAAMlB28IAAABaX5yRAAAMGQ3sYAABoJ2HUgAAN+wvaEAAABj/NjMAAANa3lnsAABzXtLEAAAMD2w7SVAAAAwG7iPzEAAA7SZ4WgAAH86WMiAABEGb/3QAAAwBxcpOFAAAPLrNhcAACCHLenAAARbP0q8AAAB8/A7/AAAQyOgV8AACO7l1LAAATMDcksAAACJzbSjAAASd59tEAACdWjejgAAVOzpXoAAADAl5V55oAAFEUauCAAAr56QegAAF6KJZmAAADAJO8+2iAABOrRvRwAAKnZ0r0AABbp8a7AAADACiKNXBAAAV89IPQAAC9FEszAAAZUUC9gAAAC1Y043AAAYWyEeAAADQ8ti+AAAcHxz5YAAADAyJ3GrQAAGv/4FKAAA52G6nQAAHwF71+AAADAM8GmX8AABvNEm7gAAO5uooQAAB/jGNTAAADADldXteAAAemu6qwAAEHbdi3AAAjF4I9wAAAD9LIdnAAAhz1gTwAAEhtTkUAAAmnfYxQAAAEWz9KvAAAlLMbCAAAE+jO3FAAAq8YR/AAAAMBIbU5FAAAJp32MUAABTAKofgAALN3DvgAAAMAT6M7cUAACrxhH8AAAXJ3mWoAADGsYduAAAAWMVn3IAAC/AIpyAAAZjsilYAADcfFQ4AAAAYmKkF4AADTgy0SAAAcXKThQAADy6zYXAAAAwGaNLSAAAA3HxUOAAAHXvJxgAAA/SyHZwAAAwBxcpOFAAAPLrNhcAACCHLenAAARbP0q8AAAB8/A7/AAAQyOgV8AACO7l1LAAATMDcksAAACJzbSjAAASd59tEAACdWjejgAAVOzpXoAAADAiNeVA4AAEjoXhTAAAnGQYBAAAFP2yb8AAADAJafWkcAABQHktBAAAK2yUTsAABdlAX6AAADACmAVQ/AAAWbuHfAAADA7MmxAAAZ4NMv4AAAC5O8y1AAAY1jDtwAADVb2xRAAAcrq9rwAAADAwtkI8AAAGh5bF8AAA4PjnywAAHgtcOGAAADANf/wKUAABzsN1OgAAPgL3r8AACErQv7AAADADubqKEAAAf4xjUwAAERryoHAAAkdC8KYAAAEHbdi3AAAjF4I9wAAEtPrSOAAAoDyWggAAAEUP35bAAAk7z7aIAAE6tG9HAAAqdnSvQAAAMBLyrzzQAAKIo1cEAABXz0g9AAAL0USzMAAAMAU/bJvwAAC1Y043AAAYWyEeAAADQ8ti+AAAAXZQF+gAADIncatAAAa//gUoAADnYbqdAAAAYrSuogAADUy1c8AAAchaomgAAD0M2BBAAAAwG2aFQcAAA6zo5GwAAH3yLp6AABDdariQAAAwB40YX2gAAQOVWjkAACKw9RCgAASjCIPsAAACFoyuagAAR04pYEAACY3aQQgAAUWZ1awnmu0b//+cVzU8qzWgNRB51F0aX/wXziXnaeSaX/Z7Oh6eCX/Z7O6X/aAAhkdAr4AAG947B8cpMZKIkXyl/KX8pfyl9pO6Tuk7pNYtYtYtXAgCZgbklgAAAOyCY0UAAB+lkOzgAAQ56wJ4AACQ2pyKHeer//+j1PRvRRB4fOO2rO2rO2rO2rPkZ7kZ7kZ7kZ8Rx8Rx8Rx8RbUAfKoEdIAAGg5Ye8rbUoKxDTFi8WLxYvFi67W+1vtb7Vjljljlh/wCOnFLAgAAAO5uooQAAB/jGNTAAARGvKgcAACR0LwpgAAAMDvtsyuAAAgIKC8oAAES91QxAAAkxjmU4AAAMBAk0wDwAAInNtKMAABJ3n20QAAJ1aN6OAAABGLwR7gAAJafWkcAABQHktBAAAK2yUTsAAABNO+xigAAKYBVD8AABZu4d8AAAMDsybE5yY///4CO8jyO/TWgLKOmJy4q3Yp44o633PcrffnlfjtcrffnncrfgACtslE7AAAkfa7ftZLtG7ZE0SLRItEi0SLJL6S+kvpLyTyTyTyK4AMidxq0AAABZu4d8AAAMDA7MmxAAAZ4NMv4AADeaJN3G6hf//7Cu93ULXvHEb85nSogkz9MNNLnD6kdTRCQ3PuddTSPw4dTSQABqt7YogAAWXpRn0mA0a0oI3uNe417jXuNaA8gPIDyA3m3m3m3haAHpruqsAAAMANx8VDgAAB17ycYAAAP0sh2cAACHPWBPAAAAOnyDvEAAB8/A7/AAAQyOgV8AACO7l1LAAAAQJNMA8AACJzbSjAAASd59tEAACdWjejgAAAwEb8HtXAAAl5V55oAAFEUauCAAAr56QegAAAwBOMgwCAAAKftk34AABasacbgAAMLZCPAAAAwAUB5LQQAACtslE7AAAXZQF+gAADIncatAAAAWbuHfAAADA7MmxAAAZ4NMv4AADeaJN3AAAAwGNYw7cAAA1W9sUQAAHK6va8AAA9Nd1VgAAAwBuPiocAAAOveTjAAADAfpZDs4AAEOesCeAAAAdPkHeIAAD5+B3+AAAhkdAr4AAEd3LqWAAAAgSaYB4AAETm2lGAAAk7z7aIAAE6tG9HAAAAwI34PauAABLyrzzQAAKIo1cEAABXz0g9AAAAwCcZBgEAAAU/bJvwAAC1Y043AAAYWyEeAAAAwAp+2TfgAAFqxpxuAAAwtkI8AAAGh5bF8AAAAuygL9AAAGRO41aAAA1//ApQAAHOw3U6AAAAwM8GmX8AABvNEm7gAAO5uooQAAB/jGNTAAAAwDldXteAAAemu6qwAAEHbdi3AAAjF4I9wAAAwA9XuKawAAIO27FuAABGLwR7gAAJafWkcAAABDnrAngAAJDanIoAABNO+xigAAKYBVD8AAABKWY2EAAAJ9GduKAABV4wj+AAALk7zLUAAADAUgqKgAAAwAsYrPuQAAF+ARTkAAAzHZFKxaFz//+/RHkHKXyOz2OBo5OJiWXlOdlGre5FxZuI6V8a9xZ986lxZ+AAV89IPQAAEm7UY9pnlnUDFZx93H3cfdx92HnR50edHmRWRWRWQOQBlRQL2AAAAMC1Y043AAAYWyEeAAADQ8ti+AAAcHxz5aQLY///sDi3YlNd/0QDXkCWepjJJgspeRXqEYMpfC3e5KYMpfC8YMpgAGv/4FKAABaOkVvR/lRScfwSz9LP0s/Sz83lx5ceXHleJeJeJdzcAfAXvX4AAADA3miTdwAAHc3UUIAAA/xjGpgAAIjXlQOAAADAO5uooQAAB/jGNTAAARGvKgcAACR0LwpgAAAQdt2LcAACMXgj3AAAS0+tI4AACgPJaCAAAASG1ORQAACad9jFAAAUwCqH4AACzdw74AAAAT6M7cUAACrxhH8AAAXJ3mWoAADGsYduF1Vf//7z2+Merd+HNqNEgy2DlTjMyzMSj7aRVPOTNPxLRVQPzORVQQABasacbgAAS/ss/2UH2KnrvOEM4QzhDOEM0H9B/Qf0H4343434zQAGh5bF8AAAAuygL9AAAGRO41aAAA1//ApQAAHOw3U6lF0v//62sNxvbWNJCGL2vbk1wrtwDVvbR6V4iwHwOntuYiwHwP4iwIABvNEm7gAAXPoYv0Jdz91nNJogmiCaIJoghd8XfF3xd3R3R3R3MMAH+MY1MAAAA5XV7XgAAHpruqsAABB23YtwAAIxeCPcAAAAwPTXdVYAACDtuxbgAARi8Ee4AACWn1pHAAAAwEOesCeAAAkNqcigAAE077GKAAApgFUPwAAAwBKWY2EAAAJ9GduKAABV4wj+AAALk7zLUAAABSCoqAAAAMCxis+5AAAX4BFOQAADMdkUrAAAAVtkonYAAC7KAv0AAAZE7jVoAADX/8ClAAAAwGB2ZNiAAAzwaZfwAAG80SbuAAA7m6ihAAAAwBqt7YogAAOV1e14AAB6a7qrAAAQdt2LcAAAB17ycYAAAMD9LIdnAAAhz1gTwAAEhtTkUAAAAfzpYyIAAEQZv/dAAAkX6xnwAAE3gAXeAAAAwIwL/myAABK/aKZAAAJ/qi/eAABWhx4TAAAAwCaJc46gAAUq6flQAACyLuTOAAAYCRaTgAAAwAqn3n0gAAFxL29AAADAMVpXUQAABqZaueAAAALk7zLUAABjWMO3AAANVvbFEAAByur2vAAAAMDMdkUrAAAbj4qHAAADr3k4wAAAwH6WQ7OAAADAOLlJwoAAB5dZsLgAAQQ5b04AACLZ+lXgAAAPn4Hf4AACGR0CvgAAR3cupYAACZgbklgAAAQ8e1bMAACQ2pyKAAATTvsYoAACmAVQ/AAAASlmNhAAACfRnbigAAVeMI/gAAC5O8y1AAAAwFIKioAAAMALGKz7kAABfgEU5AAAMx2RSsAAAMAW6fGuwAADExUgvAAAacGWiQAADi5ScKAAAAHc3UUIAAA/xjGpgAAIjXlQOAABI6F4UwAAAMCDtuxbgAARi8Ee4AACWn1pHAAAUB5LQQAAAMAkNqcigAAE077GKAAApgFUPwAAFm7h3wAAAMAJ9GduKAABV4wj+AAALk7zLUAABjWMO3AAAAK2yUTsAABdlAX6AAAMidxq0AABr/+BSgAAAMDA7MmxAAAZ4NMv4AADeaJN3AAAdzdRQgAAAMA1W9sUQAAHK6va8AAA9Nd1VgAAIO27FuAAAA695OMAAAH6WQ7OAABDnrAngAAJDanIoAAAA/xjGpgAAIjXlQOAABI6F4UwAAJxkGAQAAABGLwR7gAAJafWkcAABQHktBAAAK2yUTsAAADATTvsYoAACmAVQ/AAAWbuHfAAADA7MmxAAADAFXjCP4AAAuTvMtQAAGNYw7cAAA1W9sUQAAAF2UBfoAAAyJ3GrQAAGv/4FKAAA52G6nQAAAGeDTL+AAA3miTdwAAHc3UUIAAA/xjGpgAAAMByur2vAAAPTXdVYAACDtuxbgAARi8Ee4AAAMAfpZDs4AAEOesCeAAAkNqcigAAE077GKAAAAhkdAr4AAEd3LqWAAAmYG5JYAAFIKioAAAAwAJO8+2iAABOrRvRwAAKnZ0r0AABbp8a7AAAAMCiKNXBAAAV89IPQAAC9FEszAAAZUUC9gAAAMAtWNONwAAGFshHgAAAwNDy2L4AABwfHPlgAAAMTFSC8AABpwZaJAAAOLlJwoAAB5dZsLgAAANnr/+QAAB0+Qd4gAAPn4Hf4AACGR0CvgAAAMDwWuHDAAAgSaYB4AAETm2lGAAAk7z7aIAAAMBCVoX9gAAI34PauAABLyrzzQAAKIo1cEAAAMAR3cupYAACZgbklgAAUgqKgAAAwAsYrPuQAAAE6tG9HAAAqdnSvQAAFunxrsAAAxMVILwAAAFfPSD0AAAvRRLMwAAGVFAvYAAA2ev/5AAAAMBhbIR4AAANDy2L4AABwfHPlgAAPBa4cMAAAMAacGWiQAADi5ScKAAAeXWbC4AAEEOW9OAAAAdPkHeIAAD5+B3+AAAhkdAr4AAEd3LqWAAAAgSaYB4AAETm2lGAAAk7z7aIAAE6tG9HAAAAwI34PauAABLyrzzQAAKIo1cEAABXz0g9AAAAwCWn1pHAAAUB5LQQAACtslE7AAAXZQF+gAAAwApgFUPwAAFm7h3wAAAwOzJsQAAGeDTL+AAAAuTvMtQAAGNYw7cAAA1W9sUQAAHK6va8AAAAwMx2RSsAABuPiocAAAOveTjAAADAfpZDs4AAAMA3miTdwAAHc3UUIAAA/xjGpgAAIjXlQOAAAA9Nd1VgAAIO27FuAABGLwR7gAAJafWkcAAABDnrAngAAJDanIoAABNO+xigAAKYBVD8AAABKWY2EAAAJ9GduKAABV4wj+AAALk7zLUAAADAUB5LQQAACtslE7AAAXZQF+gAADIncatAAADAFm7h3wAAAwOzJsQAAGeDTL+AAA3miTdwAAAGNYw7cAAA1W9sUQAAHK6va8AAA9Nd1VgAAAG4+KhwAAA695OMAAAH6WQ7OAABDnrAngAAAMB3N1FCAAAP8YxqYAACI15UDgAASOheFMAAAMAg7bsW4AAEYvBHuAAAlp9aRwAAFAeS0EAAAMAJDanIoAABNO+xigAAKYBVD8AABZu4d8AAAMACfRnbigAAVeMI/gAAC5O8y1AAAY1jDtwAAADAqdnSvQAAFunxrsAAAxMVILwAAGnBlokAAADAL0USzMAABlRQL2AAANnr/+QAAB0+Qd4gAAANDy2L4AABwfHPlgAAPBa4cMAACBJpgHgAAAOdhup0AAB8Be9fgAAQlaF/YAACN+D2rgAAAMD5+B3+AAAhkdAr4AAEd3LqWAAAmYG5JYAAAMBE5tpRgAAJO8+2iAABOrRvRwAAKnZ0r0AAAMAS8q880AACiKNXBAAAV89IPQAAC9FEszAAAAU/bJvwAAC1Y043AAAYWyEeAAADQ8ti+AAAAW6fGuwAADExUgvAAAacGWiQAADi5ScKAAAAwGVFAvYAAA2ev/5AAAHT5B3iAAA+fgd/gAAAwBwfHPlgAAPBa4cMAACBJpgHgAARObaUYAAAB8Be9fgAAQlaF/YAACN+D2rgAAS8q880AAACGR0CvgAAR3cupYAACZgbklgAAUgqKgAAAMAAk7z7aIAAE6tG9HAAAqdnSvQAAFunxrsAAADAKIo1cEAABXz0g9AAAL0USzMAABlRQL2AAADAC1Y043AAAYWyEeAAADQ8ti+AAAcHxz5aug=';
export const RAMP_W = 128;
export const RAMP_H = 128;
export const RAMP_BITDEPTH = 10;

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

// The ramp is HEVC regardless of the displacement codec, so it carries its own HEVC codec probe.
const HEVC_RAMP_CODECS = [
  'hvc1.2.4.L153.B0', 'hev1.2.4.L153.B0', 'hvc1.2.4.L120.90',
  'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0', 'hvc1.1.6.L120.90',
];

// Session-global fit (a device property) — computed at most once, shared across all streams.
let _calibPromise = null;

// Decode a base64 string to bytes (the bundled ramp clip).
function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Least-squares affine fit of the recovered ramp codes to the known codes (known = pixelIndex & 1023),
// trying both vertical orientations (readback can be bottom-up). Returns { a, b, exactPct }.
function _fitRampAffine(raw, W, H) {
  const fit = (flip) => {
    const n = W * H; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const y = (i / W) | 0, x = i % W; const s = flip ? ((H - 1 - y) * W + x) : i;
      const code = i & 1023, xv = raw[s]; sx += xv; sy += code; sxx += xv * xv; sxy += xv * code;
    }
    const den = n * sxx - sx * sx, a = (n * sxy - sx * sy) / den, b = (sy - a * sx) / n;
    let ex = 0;
    for (let i = 0; i < n; i++) {
      const y = (i / W) | 0, x = i % W; const s = flip ? ((H - 1 - y) * W + x) : i;
      if (Math.round(a * raw[s] + b) === (i & 1023)) ex++;
    }
    return { a, b, exactPct: 100 * ex / n };
  };
  const up = fit(false), fl = fit(true);
  return fl.exactPct > up.exactPct ? fl : up;
}

// Probe WebCodecs for an HEVC codec string that decodes the ramp, or null if unavailable.
async function _pickRampCodec() {
  if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') return null;
  for (const codec of HEVC_RAMP_CODECS) {
    try { const r = await VideoDecoder.isConfigSupported({ codec }); if (r && r.supported) return codec; } catch (_) {}
  }
  return null;
}

// Decode the first (only) frame of the bundled ramp clip. The tiny ramp is often rejected by mobile
// HARDWARE HEVC (minimum-size limits), so try the platform default first, then explicitly software.
function _decodeRampFrame() {
  const bytes = _b64ToBytes(RAMP_HEVC_B64);
  const tryConfig = (accel) => new Promise((resolve) => {
    (async () => {
      const codec = await _pickRampCodec();
      if (!codec) return resolve(null);
      let done = false, dec = null;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const cfg = { codec, optimizeForLatency: true };
        if (accel) cfg.hardwareAcceleration = accel;
        try { const s = await VideoDecoder.isConfigSupported(cfg); if (!s || !s.supported) return finish(null); } catch (_) {}
        dec = new VideoDecoder({ output: (f) => finish(f), error: () => finish(null) });
        dec.configure(cfg);
        dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: bytes }));
        dec.flush().catch(() => {});
      } catch (_) { finish(null); }
      setTimeout(() => { finish(null); try { dec && dec.state !== 'closed' && dec.close(); } catch (_) {} }, 3000);
    })();
  });
  return (async () => {
    for (const accel of [undefined, 'prefer-software']) { const f = await tryConfig(accel); if (f) return f; }
    return null;
  })();
}

// Recover the ramp's per-pixel code: fold neutral-chroma luma -> integer code, packed hi/lo so an
// 8-bit readback carries ~16 bits, then reconstruct. Upload / render / readback via GpuReadback.
function _readRampCodes(renderer, frame, cw, ch) {
  const fs = `#version 300 es
    precision highp float;
    uniform sampler2D u_video; in vec2 uv; out vec4 o;
    void main(){
      ivec2 sz=textureSize(u_video,0);
      ivec2 tc=ivec2(floor(clamp(uv,0.,0.999999)*vec2(sz)));
      vec3 rgb=texelFetch(u_video,tc,0).rgb;
      float y=clamp((rgb.r+rgb.g+rgb.b)/3.0,0.0,1.0);
      float code=floor(y*65535.0+0.5);
      float hi=floor(code/256.0); float lo=floor(code-hi*256.0);
      o=vec4(hi/255.0, lo/255.0, 0.0, 1.0);
    }`;
  const bytes = new GpuReadback(renderer).shadeFrame(frame, cw, ch, fs);
  if (!bytes) return null;
  const codes = new Uint16Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) codes[i] = bytes[i * 4] * 256 + bytes[i * 4 + 1];
  return codes;
}

/**
 * Decode the ramp once per session and fit the recovered codes to the known ramp, yielding a
 * device-specific { scaleY, offsetY, exactPct } (or null if the ramp can't be decoded/read).
 * Session-cached and safe to call eagerly (e.g. to pre-warm the single hardware HEVC decoder).
 * @param {THREE.WebGLRenderer} renderer
 * @returns {Promise<{scaleY:number, offsetY:number, exactPct:number}|null>}
 */
export function warmupCalibration(renderer) {
  if (_calibPromise) return _calibPromise;
  _calibPromise = (async () => {
    if (!renderer) { console.warn('[calib] needs a THREE.WebGLRenderer — using default mapping'); return null; }
    try {
      const frame = await _decodeRampFrame();
      if (!frame) return null;
      const cw = frame.codedWidth || RAMP_W, ch = frame.codedHeight || RAMP_H;
      const raw = _readRampCodes(renderer, frame, cw, ch);
      try { frame.close(); } catch (_) {}
      if (!raw) return null;
      const fit = _fitRampAffine(raw, cw, ch);   // known = pixelIndex & 1023
      return { scaleY: fit.a * 65535, offsetY: fit.b, exactPct: fit.exactPct };
    } catch (e) {
      console.warn('[calib] error:', (e && e.message) || e);
      return null;
    }
  })();
  return _calibPromise;
}

/**
 * Resolve the device's displacement luma calibration: `code = round(y * scaleY + offsetY)`.
 *   'auto'            — ramp fits bit-exactly (device preserves >8-bit; ~99.7%).
 *   'auto-besteffort' — ramp fits a plausible affine below the bit-exact bar (8-bit devices): still
 *                       corrects the systematic DC bias that would otherwise inflate the model.
 *   'default'         — ramp unavailable (no HEVC / no renderer): identity full-range mapping.
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} [bitDepth=RAMP_BITDEPTH]
 * @returns {Promise<{scaleY:number, offsetY:number, maxCode:number, bitDepth:number, source:string}>}
 */
export async function resolveCalibration(renderer, bitDepth = RAMP_BITDEPTH) {
  const maxCode = (1 << bitDepth) - 1;
  const fit = await warmupCalibration(renderer);
  let cal;
  if (fit && fit.exactPct >= 95) {
    // A device that preserves >8-bit fits the ramp at ~99.7%; one that flattens to 8-bit at ~82%.
    cal = { scaleY: fit.scaleY, offsetY: fit.offsetY, maxCode, bitDepth, source: 'auto' };
  } else if (fit && Number.isFinite(fit.scaleY) && Number.isFinite(fit.offsetY)
      && fit.scaleY > maxCode * 0.6 && fit.scaleY < maxCode * 1.4
      && Math.abs(fit.offsetY) < maxCode * 0.2) {
    cal = { scaleY: fit.scaleY, offsetY: fit.offsetY, maxCode, bitDepth, source: 'auto-besteffort' };
  } else {
    // Last resort: full-range identity (code = round(y * maxCode)). Keeps rendering usable when the
    // ramp can't be decoded; not device-calibrated.
    cal = { scaleY: maxCode, offsetY: 0, maxCode, bitDepth, source: 'default' };
  }
  const pct = fit ? `${fit.exactPct.toFixed(1)}%` : 'unavailable';
  console.log(`[calib] ${cal.source} (ramp ${pct}) scaleY=${cal.scaleY.toFixed(2)} offsetY=${cal.offsetY.toFixed(2)}`);
  return cal;
}
