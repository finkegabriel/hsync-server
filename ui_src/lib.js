import { h, Component, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import apiFetch from './api-fetch.js';
import debug from 'debug';
import config from '../config.js';
import { defaultConfig } from '../index.js';

const html = htm.bind(h);

window.hsyncConfig.libs = {
  preact: {
    h,
    Component,
    render,
    useState,
    useEffect,
    html,
  },
  htm,
  apiFetch,
  debug,
};

window.hsyncConfig.libp2p = {
    p2pAddress: defaultConfig.p2pAddress,
};
