// Ticket ids in the Tasks tab's saved status text turn into the ticket's title (web/src/ticketLinks.ts).
import { expect, test } from "bun:test";
import { ticketParts } from "../web/src/ticketLinks";

const titles = new Map([["t_20261114_ekqu", "Bookshelf size enquiry"], ["t_20261101_ab12", ""]]);

test("plain text stays one piece", () => {
  expect(ticketParts("Nothing to link here.", titles)).toEqual([{ text: "Nothing to link here." }]);
  expect(ticketParts("", titles)).toEqual([]);
});

test("a known id becomes its title, with the text around it kept", () => {
  expect(ticketParts("Note added to t_20261114_ekqu (photo).", titles)).toEqual([
    { text: "Note added to " }, { id: "t_20261114_ekqu", title: "Bookshelf size enquiry" }, { text: " (photo)." },
  ]);
  expect(ticketParts("t_20261114_ekqu", titles)).toEqual([{ id: "t_20261114_ekqu", title: "Bookshelf size enquiry" }]);
});

test("unknown ids stay plain text; several ids each link", () => {
  expect(ticketParts("See t_20990101_zzzz and t_20261114_ekqu, t_20261101_ab12.", titles)).toEqual([
    { text: "See t_20990101_zzzz and " }, { id: "t_20261114_ekqu", title: "Bookshelf size enquiry" }, { text: ", " },
    { id: "t_20261101_ab12", title: "t_20261101_ab12" }, { text: "." },
  ]);
});

test("an id inside a longer word is not a link", () => {
  expect(ticketParts("xt_20261114_ekqu", titles)).toEqual([{ text: "xt_20261114_ekqu" }]);
});
